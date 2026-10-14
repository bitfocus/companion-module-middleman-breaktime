/**
 * @fileoverview BreakTime connection, state-frame handling and action requests
 *
 * Mixed into the module class. Owns the connection lifecycle (pre-connect security and
 * version checks, the state-frame WebSocket, the frame watchdog and the single re-attempt
 * timer), the REST client behind every action and its response handling, timed warnings,
 * the single status gate (`setStatus`) and the log line formatter (`logEvent`).
 *
 * Attempt flow: `initConnection()` (config-driven) or the re-attempt timer calls
 * `startConnectAttempt()`, which runs `connectAttempt()`: `GET /api/whoami`, then
 * `GET /api/version`, then `openSocket()`. A config-driven attempt (init, or a host, port
 * or key change, through `startAttempt()` in index.js) sets Connecting first; a
 * re-attempt (the re-attempt timer, or a config save while waiting on it) keeps the
 * current status. Either becomes Ok on the first state frame. Every failure schedules the
 * next attempt through `scheduleRetry()`.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

const { InstanceStatus } = require('@companion-module/base')
const WebSocket = require('ws')

const { version: MODULE_VERSION } = require('../package.json')

const {
	DURATION_MIN_S,
	DURATION_MAX_SPLICE_S,
	DURATION_MAX_TIME_SIGNAL_S,
	DURATION_STEP_MAX_S,
	PENDING_DURATION_MS,
	PRESS_DEBOUNCE_MS,
} = require('./defaults')

/** User-Agent sent on every REST request and on the WebSocket handshake */
const USER_AGENT = `companion-module-middleman-breaktime/${MODULE_VERSION}`

/** Request header that carries the BreakTime API key */
const API_KEY_HEADER = 'X-BreakTime-Key'

/**
 * A system error code such as `ECONNREFUSED` or `UND_ERR_CONNECT_TIMEOUT`: the only fetch error detail the
 * module repeats
 */
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

/** Ack outcome that means BreakTime acted on the request */
const OUTCOME_ACCEPTED = 'Accepted'

/** Status message when BreakTime security is on and no API key is configured */
const MSG_NEED_KEY = 'API key required: BreakTime security is on. Enter it under Show Advanced Settings.'

/** Status message when BreakTime rejects the configured API key */
const MSG_KEY_REJECTED = 'BreakTime rejected the API key'

/** Status message while BreakTime answers the WebSocket route before its startup completes */
const MSG_STARTING = 'BreakTime is starting'

/** Close reason when an action request got HTTP 401 and the socket is dropped to re-check authentication */
const MSG_ACTION_401 = 'BreakTime needs a valid API key, reconnecting'

/** Local-guard reason when the armed event cannot be trusted because no live state frame backs it */
const MSG_ARMED_UNKNOWN = 'Not connected to BreakTime'

/** Local-guard reason when the running events cannot be known because no live state frame backs them */
const MSG_RUNNING_UNKNOWN = 'Not connected to BreakTime'

/** Local-guard reason when nothing is armed (including an armed event that was deleted) */
const MSG_NOTHING_ARMED = 'Nothing armed'

/** Local-guard reason when an action option names no event */
const MSG_NO_EVENT_CHOSEN = 'No event chosen'

/** Local-guard reason when an action option names an event that is not in the playlist */
const MSG_NOT_IN_PLAYLIST = 'Event is not in the playlist'

/**
 * Standby-node warning for an arm (HA standby rule: Paired and not Acting): the acting node's arm normally
 * replaces it on the next heartbeat
 */
const MSG_STANDBY_ARM = "Sent to the standby instance. The live instance's arm may replace it."

/**
 * Standby-node warning for a duration change (HA standby rule: Paired and not Acting): BreakTime does not
 * replicate it
 */
const MSG_STANDBY_DURATION = 'Sent to the standby instance. Duration changes are not copied to the live instance.'

/** Log latch for a state frame that failed to parse or apply; cleared by the next clean pass */
const LATCH_FRAME_ERROR = 'state:frame error'

/** Frame-error reason for a frame that is valid JSON but not an object */
const MSG_FRAME_NOT_OBJECT = 'State frame is not a JSON object'

/** Local-guard reason logged for an arm press still waiting to be sent when a host or port change dropped it */
const MSG_ARM_DROPPED = 'Connection settings changed before the arm was sent'

/** Local-guard reason for a Start or End press ignored by the press debounce (see `isPressDebounced`) */
const MSG_PRESSED_AGAIN = `Pressed again within ${PRESS_DEBOUNCE_MS / 1000} s`

/**
 * One playlist event as BreakTime sends it in a state frame (`Playlist.Events[]`, PascalCase)
 *
 * While the WebSocket is down the module keeps only `ID` and `Name` of each event (see
 * `handleDisconnect()`), so every other field may be undefined. BreakTime sends more
 * fields (SCTE options, `ActuationFiringId`, ...) that the module does not read.
 *
 * @typedef {Object} BreakTimeEvent
 * @property {string} ID - Event ID: lowercase hyphenated GUID
 * @property {string} Name - Event name
 * @property {string} [Description] - Event description
 * @property {0|1} [DurationMode] - 0 Count Down, 1 Count Up
 * @property {number} [DurationSeconds] - Duration in seconds; 6 s floor, ceilings 6553 s (Splice Insert) /
 *   65535 s (Time Signal)
 * @property {0|1} [MessageMode] - 0 Splice Insert, 1 Time Signal
 * @property {0|1} [Status] - 0 Stopped, 1 Running
 * @property {number} [ElapsedSeconds] - Whole seconds since the start, recomputed each tick
 * @property {number} [RemainingSeconds] - Whole seconds left; meaningful only for Count Down (for Count Up it is
 *   `DurationSeconds - ElapsedSeconds` and can go negative)
 * @property {number} [StartMS] - BreakTime's per-node stopwatch at the start; orders running events
 * @property {string|null} [StartTime] - Start time as BreakTime formats it
 * @property {number} [ActuationSpliceEventID] - SCTE splice event ID of the last actuation (Splice Insert); 0 for none
 * @property {number} [ActuationSegmentationEventID] - SCTE segmentation event ID of the last actuation
 *   (Time Signal); 0 for none
 */

/**
 * BreakTime's HA block in a state frame; its enum values are JSON strings holding the name
 * @typedef {Object} HaState
 * @property {'Undefined'|'Primary'|'Secondary'} Role - `Undefined` on an unlicensed node
 * @property {boolean} Paired - True while paired with a partner
 * @property {boolean} Acting - Mirrors write authority; not on its own "this node will emit"
 * @property {boolean} Promoted - True on a promoted Secondary
 * @property {boolean} EmitReady - True when this node is ready to emit
 * @property {'Inactive'|'Connecting'|'Connected'|'Degraded'} LinkState - Peer link state; `Inactive` is
 *   standalone, not a fault
 * @property {string|null} PeerRole - Partner role, or null while the link is not connected
 * @property {string} LinkDetail - Link detail text
 * @property {string} EmitOutputDetail - Emit output detail text
 * @property {string} InstanceID - This node's instance ID
 */

/**
 * One state frame from `/api/ws` (JSON text, PascalCase, about 1 per second plus extra frames on changes)
 *
 * Null keys are written as `null`. Event and component enums are integers; the `HA`
 * enums are strings. `HA` is always present in BreakTime 2.0 and absent in 1.x, which is
 * how the first frame tells them apart. Only the keys listed here are read; BreakTime
 * sends many more.
 *
 * @typedef {Object} StateFrame
 * @property {{Events: BreakTimeEvent[]}} Playlist - The playlist, in playlist order
 * @property {BreakTimeEvent|null} NextEvent - The armed event, or null; a live pointer BreakTime does not check
 *   against the playlist (it can name a deleted event)
 * @property {BreakTimeEvent|null} LastStartedEvent - The last event started locally since BreakTime started, or
 *   null; never cleared, so it may be stale
 * @property {Object<string, {Status: 0|1|2|3, StatusDetail: string}>} ComponentStatuses - Component status by
 *   key (`Status`: 0 Disabled, 1 Unhealthy, 2 Warning, 3 Healthy)
 * @property {HaState|null} HA - HA state
 * @property {string|null} HARoleAlarm - HA role alarm text, or null
 * @property {string|null} GlobalWarning - One-shot warning text, cleared by BreakTime after each broadcast
 * @property {*} [SCTE104TCPClient] - Legacy SCTE 104 client block (not read)
 * @property {*} [SCTE104TCPServer] - Legacy SCTE 104 server block (not read)
 * @property {*} [vMixClient] - Legacy vMix block (not read; the module reads `ComponentStatuses`)
 */

/**
 * Ack BreakTime returns (HTTP 200) for start, start-armed, end and next-event, in camelCase
 *
 * Success is keyed on `outcome`, never on `eventId` being present (`EventNotFound` echoes
 * the requested ID). `detail` is prose and is never branched on.
 *
 * @typedef {Object} FireAck
 * @property {boolean} acted - `outcome === 'Accepted'`
 * @property {boolean} emitted - True when a message was sent to at least one output
 * @property {'Accepted'|'NotLicensed'|'UnpairedSecondary'|'RecoveringState'|'EventNotFound'|'AlreadyInThatState'|
 *   'PlaylistReplaced'|'DuplicateActuation'|'NothingArmed'} outcome - Decided outcome
 * @property {string} detail - Human-readable explanation
 * @property {string|null} emissionDetail - Non-null on every `emitted:true` ack: `sent to X`, or
 *   `sent to X; <refusal>` for a partial send
 * @property {string|null} eventId - Lowercase hyphenated GUID of the event acted on; null for `NothingArmed`
 * @property {string|null} firingId - GUID matching BreakTime's history; null on every refusal and on an accepted arm
 * @property {number|null} actuationSeq - Actuation sequence number; null on every refusal and on an accepted arm
 */

/**
 * Result of one REST request; `sendREST` returns it to the action handlers
 * @typedef {Object} RestResult
 * @property {number} status - HTTP status code, 0 when no response arrived
 * @property {*} body - Parsed JSON body, the raw text when it is not JSON, or null when empty
 * @property {number} took - Milliseconds from request start to the end of the body
 * @property {'timeout'|'network'|null} error - Why no response arrived, or null when one did
 * @property {string} errorText - System error code, or `request error` when there is none; '' when a response arrived
 * @property {number} [gen] - Attempt generation when the request was sent (`sendREST` only), so a late 401
 *   cannot drop a newer socket
 */

/**
 * A Set Armed Duration target BreakTime accepted but no state frame shows yet
 * @typedef {Object} PendingDuration
 * @property {string} id - Event ID
 * @property {number} seconds - Duration BreakTime now holds for that event
 * @property {number} until - Time (ms since epoch) after which the value is no longer trusted
 */

/**
 * Connection target captured at the start of an attempt, so a config change mid-attempt cannot redirect it
 * @typedef {Object} AttemptTarget
 * @property {string} host - Normalized host
 * @property {string} port - Normalized port
 * @property {string} apiKey - Normalized API key, '' when none is set
 */

/**
 * One action gesture's request description, passed to `reportActionResult`
 * @typedef {Object} ActionSpec
 * @property {string} verb - `action:` verb of the module's log convention (`<area>: <verb> key=value`), e.g.
 *   `start` or `arm next`
 * @property {'start'|'startArmed'|'end'|'arm'|'duration'} kind - Route family; selects the response rules
 * @property {Object<string, *>} fields - Leading log fields (target, event, id, delta, to), in output order
 * @property {string} [warningType] - Warning type for duration refusals (`increaseDuration` / `decreaseDuration`)
 * @property {boolean} [acting] - HA acting flag, logged as `acting=` when set (standby gestures, see
 *   `getStandbyWarning`)
 * @property {string} [standbyWarning] - `ha` warning text raised when the response raised no warning of its own
 * @property {boolean} [deferWarning] - When true the warning is returned in the report instead of raised
 *   (End `all` combines them)
 * @property {function(ActionReport): void} [beforeLog] - Called with the report just before the gesture's line
 *   is written (arm presses folded into this request log there, so lines follow press order)
 */

/**
 * A timed warning to raise
 * @typedef {Object} WarningSpec
 * @property {string} type - Warning type ID from CHOICES_WARNINGS
 * @property {string} text - Warning text
 */

/**
 * What one action response meant, returned by `reportActionResult`
 * @typedef {Object} ActionReport
 * @property {string} outcome - Ack outcome verbatim, or `Timeout`, `NetworkError`, `HttpError` or `Unknown`
 * @property {boolean} accepted - True when the outcome is `Accepted`
 * @property {boolean} unknown - True when the request may have been applied but no answer says so (timeout, or
 *   500 on an ack route)
 * @property {FireAck|null} ack - The parsed ack, when the response carried one
 * @property {WarningSpec|null} warning - The warning this response called for; only filled when the spec set
 *   `deferWarning`
 * @property {{outcome: string, http: (number|undefined), reason: (string|undefined),
 *   firingId: (string|null|undefined), seq: (number|null|undefined), detail: (string|null|undefined)}|null} logFields -
 *   Outcome keys of the logged line, in output order, read by `logFoldedArm()`; null when nothing was logged
 */

/**
 * One Arm Next, Arm Previous or Arm Event press waiting for, or leading, an arm request
 * @typedef {Object} ArmPress
 * @property {string} verb - `action:` verb (`arm`, `arm next` or `arm previous`)
 * @property {{ID: string, Name?: string}} event - The press's own target
 * @property {string} standbyWarning - `ha` warning text when sent to a standby node, '' otherwise
 * @property {number} started - Time of the press (ms since epoch), for `took=`
 */

/**
 * The arm request in flight and the presses made while it runs
 * @typedef {Object} ArmFlight
 * @property {ArmPress[]} waiting - Presses made while the request runs, in press order; the last one's target is
 *   sent next
 * @property {boolean} dropped - True once a host or port change dropped the waiting presses: the request in
 *   flight went to the previous server, so no later press may fold into it
 */

/**
 * Returns the major version number of a BreakTime version string, or null when it has none
 *
 * Example: `2.0.222-beta+e8d7026389` gives 2; `unknown` gives null.
 *
 * @private
 * @param {string} version - Version string from `GET /api/version`
 * @returns {number|null} Major version, or null when unparsable
 */
function parseMajorVersion(version) {
	const match = /^(\d+)(?:[.+-]|$)/.exec(version)

	return match ? Number(match[1]) : null
}

/**
 * Parses a response body as JSON, falling back to the raw text
 *
 * @private
 * @param {string} text - Response body text
 * @returns {*} Parsed value, the text itself when it is not JSON, or null when empty
 */
function parseBody(text) {
	if (text === '') {
		return null
	}

	try {
		return JSON.parse(text)
	} catch {
		return text
	}
}

/**
 * Returns true when a parsed body has the shape of a BreakTime fire ack
 *
 * @private
 * @param {*} body - Parsed response body
 * @returns {boolean} True for an object with a string `outcome`
 */
function isAck(body) {
	return body !== null && typeof body === 'object' && typeof body.outcome === 'string'
}

/**
 * Returns true when a parsed state frame is a JSON object (not null, an array or a scalar)
 *
 * @private
 * @param {*} data - Parsed frame
 * @returns {boolean} True for a plain JSON object
 */
function isFrameObject(data) {
	return data !== null && typeof data === 'object' && !Array.isArray(data)
}

/**
 * Sort comparator for running events: newest first by `StartMS`
 *
 * `StartMS` is BreakTime's per-node stopwatch. `Array.prototype.sort` is stable, so
 * events with the same `StartMS` keep their playlist order.
 *
 * @private
 * @param {BreakTimeEvent} a - Running event
 * @param {BreakTimeEvent} b - Running event
 * @returns {number} Negative when `a` started later than `b`
 */
function compareStartDescending(a, b) {
	return (Number(b.StartMS) || 0) - (Number(a.StartMS) || 0)
}

/**
 * Sort comparator for running events that have no slot yet: oldest first by `StartMS`
 *
 * Stable, so events with the same `StartMS` keep their input order. `DATA.running`
 * lists ties in playlist order, so ties go to the earlier playlist entry first.
 *
 * @private
 * @param {BreakTimeEvent} a - Running event
 * @param {BreakTimeEvent} b - Running event
 * @returns {number} Negative when `a` started earlier than `b`
 */
function compareStartAscending(a, b) {
	return (Number(a.StartMS) || 0) - (Number(b.StartMS) || 0)
}

/**
 * Clamps a duration to the range BreakTime enforces for an event's message mode
 *
 * @private
 * @param {number} seconds - Duration in seconds
 * @param {number} messageMode - `MessageMode`: 0 Splice Insert, 1 Time Signal
 * @returns {number} Duration clamped to 6..6553 (Splice Insert) or 6..65535 (Time Signal)
 */
function clampDuration(seconds, messageMode) {
	const max = messageMode === 1 ? DURATION_MAX_TIME_SIGNAL_S : DURATION_MAX_SPLICE_S

	return Math.min(Math.max(seconds, DURATION_MIN_S), max)
}

/**
 * Returns true for the two component statuses whose changes between each other are logged at debug only
 *
 * @private
 * @param {string|undefined} status - Component status name
 * @returns {boolean} True for Healthy or Warning
 */
function isHealthyOrWarning(status) {
	return status === 'Healthy' || status === 'Warning'
}

module.exports = {
	/**
	 * Starts a fresh, config-driven connection attempt
	 *
	 * Called by index.js after init or a host, port or key change. Resets the lost streak
	 * (so the next success logs `conn: connected`, not `restored`) and the connection log
	 * latches, so the new target's first failure is logged.
	 *
	 * @returns {void}
	 */
	initConnection: function () {
		let self = this

		self.lostAt = null
		self.attempts = 0
		self.clearLogLatches('conn:')
		self.clearLogLatches('rest:')

		self.startConnectAttempt()
	},

	/**
	 * Starts one connection attempt without awaiting it
	 *
	 * Closes any socket and pending re-attempt first, then captures a new attempt
	 * generation and the target. The attempt promise always ends in `.catch`: on Node 22 an
	 * unhandled rejection ends the process, and base installs no handler. Called by
	 * `initConnection()`, by the re-attempt timer, and by `configUpdated` while waiting on
	 * that timer. Never sets Connecting itself, so a re-attempt keeps the current status
	 * until its outcome differs.
	 *
	 * @returns {void}
	 */
	startConnectAttempt: function () {
		let self = this

		self.closeConnection()

		if (self.destroyed) {
			return
		}

		const gen = ++self.attemptGen

		/** @type {AttemptTarget} */
		const target = { host: self.config.host, port: self.config.port, apiKey: self.apiKey }

		self.handshakeOutcome = null

		if (self.lostAt !== null) {
			self.attempts++
		}

		self.connectAttempt(gen, target).catch((error) => {
			if (self.destroyed || gen !== self.attemptGen) {
				return
			}

			self.closeConnection()
			self.reportConnectionFailure(target, `Connection attempt failed: ${error?.message ?? String(error)}`)
			self.scheduleRetry(self.RECONNECT_MS)
		})
	},

	/**
	 * Runs the pre-connect checks for one attempt and opens the WebSocket when both pass
	 *
	 * 1. `GET /api/whoami` (anonymous) reads whether BreakTime security is on. Security on
	 *    with no key ends the attempt as AuthenticationFailure; a 404 (BreakTime 1.x) or any
	 *    failure continues to check 2.
	 * 2. `GET /api/version` (with the key) gates the WebSocket: 2.x passes, 1.x or 404 is
	 *    reported as BadConfig and re-checked every VERSION_RECHECK_MS, 401 is
	 *    AuthenticationFailure, anything else ConnectionFailure.
	 *
	 * After every `await` the attempt returns early when it is stale (a newer attempt
	 * started, or the module was destroyed): before a socket exists, the socket identity
	 * check cannot catch a stale continuation, and a config change mid-check would otherwise
	 * open a second socket to the old host.
	 *
	 * A whoami failure is logged (`rest: failed`) only once the version check shows
	 * BreakTime is reachable: during an outage both checks fail, and the version check's
	 * `conn: lost` is then the only line. The `breaktime_security` and `breaktime_version`
	 * values are pushed as soon as they change, because the AuthenticationFailure and
	 * pre-2.0 paths never reach a state frame.
	 *
	 * @async
	 * @param {number} gen - Attempt generation captured by `startConnectAttempt()`
	 * @param {AttemptTarget} target - Host, port and key captured at attempt start
	 * @returns {Promise<void>}
	 */
	connectAttempt: async function (gen, target) {
		let self = this

		const isStale = () => self.destroyed || gen !== self.attemptGen

		// Check 1: security
		const whoami = await self.restRequest('GET', '/api/whoami', undefined, '', target)

		if (isStale()) {
			return
		}

		/** Reason to log for a failed whoami once BreakTime proves reachable; null when whoami was usable */
		let whoamiFailure = null

		if (whoami.status === 200 && typeof whoami.body?.authEnabled === 'boolean') {
			self.logLatches.delete('rest:/api/whoami')
			self.setBreakTimeInfo('breaktimeSecurity', whoami.body.authEnabled ? 'On' : 'Off')

			if (whoami.body.authEnabled && !target.apiKey) {
				self.reportAuthFailure(target, MSG_NEED_KEY)
				self.scheduleRetry(self.RECONNECT_MS)
				return
			}
		} else if (whoami.status !== 404) {
			// A 200 here carried a body without a boolean `authEnabled`
			whoamiFailure = whoami.status === 200 ? 'Unexpected response from BreakTime' : self.describeFailure(whoami)
		}

		// Check 2: version
		const version = await self.restRequest('GET', '/api/version', undefined, target.apiKey, target)

		if (isStale()) {
			return
		}

		if (whoamiFailure !== null && (version.status === 200 || version.status === 401 || version.status === 404)) {
			self.logRestFailure(target, 'GET', '/api/whoami', whoami, whoamiFailure)
		}

		if (version.status === 200) {
			const raw = typeof version.body?.version === 'string' ? version.body.version : ''
			const major = parseMajorVersion(raw)

			self.setBreakTimeInfo('breaktimeVersion', raw)

			if (major === null) {
				self.logRestFailure(target, 'GET', '/api/version', version, 'Version not recognized')
			} else if (major < 2) {
				self.reportUnsupported(target, self.buildUnsupportedMessage(target, raw))
				self.scheduleRetry(self.VERSION_RECHECK_MS)
				return
			} else {
				self.logLatches.delete('rest:/api/version')
			}
		} else if (version.status === 404) {
			self.reportUnsupported(target, self.buildUnsupportedMessage(target, ''))
			self.scheduleRetry(self.VERSION_RECHECK_MS)
			return
		} else if (version.status === 401) {
			self.setBreakTimeInfo('breaktimeSecurity', 'On')
			self.reportAuthFailure(target, target.apiKey ? MSG_KEY_REJECTED : MSG_NEED_KEY, 401)
			self.scheduleRetry(self.RECONNECT_MS)
			return
		} else {
			self.reportConnectionFailure(target, self.describeFailure(version), version.status || undefined)
			self.scheduleRetry(self.RECONNECT_MS)
			return
		}

		self.openSocket(target)
	},

	/**
	 * Opens the state-frame WebSocket and wires its handlers
	 *
	 * Every handler returns early when its socket is no longer `self.WS`, so a replaced or
	 * closed socket can never change state. A non-101 handshake response is classified in
	 * `unexpected-response` and recorded in `handshakeOutcome`, which stops the following
	 * `error` and `close` from overwriting that status (the reconnect still runs, after
	 * VERSION_RECHECK_MS when the handshake showed a server that is not BreakTime 2.0).
	 *
	 * A new socket invalidates the change-detection snapshot and the previous event list, so
	 * its first frame pushes every value and always rebuilds the event choices.
	 *
	 * @private
	 * @param {AttemptTarget} target - Host, port and key captured at attempt start
	 * @returns {void}
	 */
	openSocket: function (target) {
		let self = this

		const ws = new WebSocket(`ws://${target.host}:${target.port}/api/ws`, {
			headers: self.buildHeaders(target.apiKey),
			handshakeTimeout: self.HANDSHAKE_TIMEOUT_MS,
		})

		/** True once this socket delivered a valid first frame (status Ok) */
		let frameSeen = false

		self.WS = ws
		self.closeReason = ''
		self.snapshot = null
		self.eventListKeys = null

		ws.on('unexpected-response', (_request, response) => {
			if (ws !== self.WS) {
				return
			}

			self.handleHandshakeResponse(target, response.statusCode)
			ws.terminate()
		})

		ws.on('open', () => {
			if (ws !== self.WS) {
				return
			}

			self.armWatchdog(ws)
			self.requestState()
		})

		ws.on('message', (raw) => {
			if (ws !== self.WS) {
				return
			}

			self.WATCHDOG_TIMEOUT?.refresh()

			const data = self.parseFrame(raw)

			if (data === undefined) {
				return
			}

			if (!frameSeen) {
				frameSeen = self.handleFirstFrame(target, data)

				if (!frameSeen) {
					return
				}
			}

			self.processData(data)
		})

		ws.on('error', (error) => {
			if (ws !== self.WS) {
				return
			}

			// The close handler reports it; keep the first cause (e.g. a watchdog trip)
			if (!self.closeReason) {
				self.closeReason = self.describeSocketError(error)
			}
		})

		ws.on('close', (code) => {
			if (ws !== self.WS) {
				return
			}

			self.WS = null

			if (self.WATCHDOG_TIMEOUT) {
				clearTimeout(self.WATCHDOG_TIMEOUT)
				self.WATCHDOG_TIMEOUT = null
			}

			if (!self.handshakeOutcome) {
				if (frameSeen) {
					self.lostAt = Date.now()
					self.attempts = 0
					self.handleDisconnect()
				}

				self.reportConnectionFailure(
					target,
					self.closeReason || `Connection to BreakTime closed (code ${code})`,
				)
			}

			// A handshake 404 is a pre-2.0 outcome: re-check on the slow interval
			const unsupported = self.handshakeOutcome?.status === InstanceStatus.BadConfig

			self.scheduleRetry(unsupported ? self.VERSION_RECHECK_MS : self.RECONNECT_MS)
		})
	},

	/**
	 * Classifies a non-101 WebSocket handshake response and reports it
	 *
	 * 401 is AuthenticationFailure, 404 means the server is not BreakTime 2.0, and 200 means
	 * BreakTime answered before its startup completed (it stays Connecting and is retried).
	 * Anything else is ConnectionFailure. The outcome is per attempt.
	 *
	 * @private
	 * @param {AttemptTarget} target - Attempt target
	 * @param {number} code - HTTP status code of the handshake response
	 * @returns {void}
	 */
	handleHandshakeResponse: function (target, code) {
		let self = this

		if (code === 401) {
			self.handshakeOutcome = { status: InstanceStatus.AuthenticationFailure }
			self.reportAuthFailure(target, target.apiKey ? MSG_KEY_REJECTED : MSG_NEED_KEY, 401)
		} else if (code === 404) {
			self.handshakeOutcome = { status: InstanceStatus.BadConfig }
			self.reportUnsupported(target, 'Not a BreakTime 2.0 server', 404)
		} else if (code === 200) {
			self.handshakeOutcome = { status: InstanceStatus.Connecting }
			self.setStatus(InstanceStatus.Connecting, MSG_STARTING)
			self.logConn('info', 'starting', {
				host: `${target.host}:${target.port}`,
				status: InstanceStatus.Connecting,
				http: 200,
				reason: MSG_STARTING,
			})
		} else {
			self.handshakeOutcome = { status: InstanceStatus.ConnectionFailure }
			self.reportConnectionFailure(target, `Unexpected response from BreakTime (HTTP ${code})`, code)
		}
	},

	/**
	 * Validates the first state frame on a socket and moves the status to Ok
	 *
	 * A frame that is not a JSON object is logged (once) as a frame error and the socket
	 * keeps waiting for a valid one. An object without the `HA` key comes from BreakTime 1.x
	 * (`"HA": null` does not): the socket is closed, the server is reported as unsupported,
	 * and it is re-checked after VERSION_RECHECK_MS. Otherwise logs `conn: connected`, or
	 * `conn: restored` after a loss.
	 *
	 * @private
	 * @param {AttemptTarget} target - Attempt target
	 * @param {*} data - Parsed frame
	 * @returns {boolean} True when the frame was accepted and should be applied
	 */
	handleFirstFrame: function (target, data) {
		let self = this

		if (!isFrameObject(data)) {
			self.logFrameError(new Error(MSG_FRAME_NOT_OBJECT))
			return false
		}

		if (!Object.hasOwn(data, 'HA')) {
			self.closeConnection()
			self.reportUnsupported(target, self.buildUnsupportedMessage(target, self.DATA.breaktimeVersion))
			self.scheduleRetry(self.VERSION_RECHECK_MS)
			return false
		}

		const restored = self.lostAt !== null

		const fields = {
			host: `${target.host}:${target.port}`,
			status: InstanceStatus.Ok,
			attempts: restored ? self.attempts : undefined,
			down: restored ? self.formatDuration(Date.now() - self.lostAt) : undefined,
			version: self.DATA.breaktimeVersion,
			security: self.DATA.breaktimeSecurity ? self.DATA.breaktimeSecurity.toLowerCase() : 'unknown',
			role: data.HA?.Role,
			acting: data.HA?.Acting,
		}

		self.lostAt = null
		self.attempts = 0
		self.clearLogLatches('conn:')

		self.setStatus(InstanceStatus.Ok)
		self.logEvent('info', 'conn', restored ? 'restored' : 'connected', fields)

		return true
	},

	/**
	 * Parses one raw state frame, logging a parse failure once per streak
	 *
	 * Hot path (about 1 frame per second). Writes the raw frame as a debug dump only when
	 * both Verbose Logging and Log Raw BreakTime Data are on.
	 *
	 * @private
	 * @param {import('ws').RawData} raw - Raw frame payload
	 * @returns {*} The parsed frame, or undefined when it is not valid JSON
	 */
	parseFrame: function (raw) {
		let self = this

		if (self.config.verboseWebsocket && self.config.verbose) {
			self.log('debug', `state: frame dump ${raw}`)
		}

		try {
			return JSON.parse(raw)
		} catch (error) {
			self.logFrameError(error)
			return undefined
		}
	},

	/**
	 * Logs `state: frame error` once per streak of failing passes
	 *
	 * Owns the frame-error latch shared by `processData()`, `refreshState()` and the
	 * arm-request guards in `armEvent()` and `runArmRequest()`: the first failure logs,
	 * repeats stay silent, and the next clean pass clears the latch.
	 *
	 * @private
	 * @param {*} error - What was thrown
	 * @returns {void}
	 */
	logFrameError: function (error) {
		let self = this

		if (self.logLatches.has(LATCH_FRAME_ERROR)) {
			return
		}

		self.logLatches.add(LATCH_FRAME_ERROR)
		self.logEvent('error', 'state', 'frame error', { reason: error?.message ?? String(error) })
	},

	/**
	 * Pushes the current state to Companion (changed variables, affected feedbacks), containing any throw
	 *
	 * The guarded entry for every caller outside the frame path (init, config changes,
	 * warnings and their expiry timer, disconnect, action results). An uncaught throw from a
	 * timer callback would end the module process (base installs no `uncaughtException`
	 * handler), so a throw is logged through the shared frame-error latch instead. A no-op
	 * after `destroy()`: a late request answer or timer must not push to a torn-down
	 * connection.
	 *
	 * @returns {void}
	 */
	refreshState: function () {
		let self = this

		if (self.destroyed) {
			return
		}

		try {
			self.checkVariables()
			self.logLatches.delete(LATCH_FRAME_ERROR)
		} catch (error) {
			self.logFrameError(error)
		}
	},

	/**
	 * Stores a BreakTime server fact learned by the pre-connect checks and pushes it when it changed
	 *
	 * @private
	 * @param {'breaktimeSecurity'|'breaktimeVersion'} key - DATA field
	 * @param {string} value - New value
	 * @returns {void}
	 */
	setBreakTimeInfo: function (key, value) {
		let self = this

		if (self.DATA[key] === value) {
			return
		}

		self.DATA[key] = value
		self.refreshState()
	},

	/**
	 * Returns true while a live socket has delivered its first frame (status Ok), so the cached state can be trusted
	 *
	 * @returns {boolean} True when the armed and running state reflect BreakTime
	 */
	isLive: function () {
		return this.WS !== null && this.lastStatus === InstanceStatus.Ok
	},

	/**
	 * Hook: resets frame-derived state when the WebSocket drops after delivering frames
	 *
	 * Called by the close handler for a socket that reached Ok, and by index.js before a
	 * config-driven reconnect of a live socket. The armed event and the event list keep only
	 * ID and name (run state unknown, so `selected_status` reads Unknown and the times read
	 * ''), running state is cleared (`running_events_count`, every running slot, the
	 * latest running values and `running_events_json` go blank) while the slot
	 * assignments are kept for the next frame (see `assignRunningSlots()`), the connectivity
	 * buckets and every component go Unknown (so the connected and disconnected feedbacks
	 * both read false), the HA values go '' and the role alarm is treated as null (so
	 * `message` shows only an active timed warning), the pending duration is dropped and the
	 * Start and End press debounce windows are released.
	 * An arm request still in flight is left to settle, and presses waiting on it are still
	 * sent when it answers: they go to the same host, and their targets are still what the
	 * operator pressed (see `armEvent()`). The change-detection snapshot and the previous
	 * event list are invalidated, so this push writes every value in one batched
	 * `setVariableValues()` with one `checkFeedbacks()`, and the first frame after
	 * reconnect counts as fully changed.
	 *
	 * @returns {void}
	 */
	handleDisconnect: function () {
		let self = this

		const DATA = self.DATA
		const armed = DATA.selectedEvent

		DATA.selectedEvent = armed?.ID ? { ID: armed.ID, Name: armed.Name } : undefined
		DATA.events = DATA.events.map((event) => ({ ID: event.ID, Name: event.Name }))
		DATA.running = []
		DATA.runningEventsCount = ''
		DATA.scte104Status = 'Unknown'
		DATA.vmixStatus = 'Unknown'
		DATA.ha = null
		DATA.haRoleAlarm = null

		self.assignRunningSlots()

		for (const slug in DATA.components) {
			DATA.components[slug].status = 'Unknown'
			DATA.components[slug].detail = ''
		}

		self.pendingDuration = null
		self.releasePressWindows()
		self.eventListKeys = null
		self.snapshot = null

		self.refreshState()
	},

	/**
	 * Schedules the next connection attempt on the single re-attempt timer
	 *
	 * Every re-attempt goes through here: the WebSocket reconnect, the auth retry, the
	 * ConnectionFailure retry (all RECONNECT_MS) and the pre-2.0 re-check
	 * (VERSION_RECHECK_MS). Clears any pending timer first, so timers never accumulate, and
	 * does nothing after `destroy()`. Fixed delay, no backoff.
	 *
	 * @param {number} ms - Delay before the next attempt
	 * @returns {void}
	 */
	scheduleRetry: function (ms) {
		let self = this

		if (self.RETRY_TIMEOUT) {
			clearTimeout(self.RETRY_TIMEOUT)
			self.RETRY_TIMEOUT = null
		}

		if (self.destroyed) {
			return
		}

		self.RETRY_TIMEOUT = setTimeout(() => {
			self.RETRY_TIMEOUT = null
			self.startConnectAttempt()
		}, ms)
	},

	/**
	 * Arms the frame watchdog for a socket
	 *
	 * Refreshed by every frame. When no frame arrives within WATCHDOG_MS the socket is
	 * terminated directly, and its close handler reports the loss and reconnects.
	 *
	 * @private
	 * @param {import('ws')} ws - The socket being watched
	 * @returns {void}
	 */
	armWatchdog: function (ws) {
		let self = this

		if (self.WATCHDOG_TIMEOUT) {
			clearTimeout(self.WATCHDOG_TIMEOUT)
		}

		self.WATCHDOG_TIMEOUT = setTimeout(() => {
			self.WATCHDOG_TIMEOUT = null

			if (ws !== self.WS) {
				return
			}

			self.closeReason = `No update from BreakTime for ${Math.round(self.WATCHDOG_MS / 1000)}s`
			ws.terminate()
		}, self.WATCHDOG_MS)
	},

	/**
	 * Reports a connection failure: ConnectionFailure status plus one `conn: lost` line per streak
	 *
	 * @private
	 * @param {AttemptTarget} target - Attempt target
	 * @param {string} reason - Status message, also the logged `reason`
	 * @param {number} [http] - HTTP status code, when the failure was an HTTP response
	 * @returns {void}
	 */
	reportConnectionFailure: function (target, reason, http) {
		let self = this

		self.setStatus(InstanceStatus.ConnectionFailure, reason)
		self.logConn('warn', 'lost', {
			host: `${target.host}:${target.port}`,
			status: InstanceStatus.ConnectionFailure,
			http: http,
			reason: reason,
		})
	},

	/**
	 * Reports an authentication failure: AuthenticationFailure status plus one `conn: auth failed` line
	 *
	 * @private
	 * @param {AttemptTarget} target - Attempt target
	 * @param {string} reason - Status message, also the logged `reason`
	 * @param {number} [http] - HTTP status code, when BreakTime answered 401
	 * @returns {void}
	 */
	reportAuthFailure: function (target, reason, http) {
		let self = this

		self.setStatus(InstanceStatus.AuthenticationFailure, reason)
		self.logConn('error', 'auth failed', {
			host: `${target.host}:${target.port}`,
			status: InstanceStatus.AuthenticationFailure,
			http: http,
			reason: reason,
		})
	},

	/**
	 * Reports an unsupported server: BadConfig status, one `conn: unsupported` line and a `version` warning
	 *
	 * The warning is raised with the log line, once per streak, not on every re-check.
	 *
	 * @private
	 * @param {AttemptTarget} target - Attempt target
	 * @param {string} reason - Status message, also the logged `reason`
	 * @param {number} [http] - HTTP status code, when a handshake response gave it away
	 * @returns {void}
	 */
	reportUnsupported: function (target, reason, http) {
		let self = this

		self.setStatus(InstanceStatus.BadConfig, reason)

		const logged = self.logConn('error', 'unsupported', {
			host: `${target.host}:${target.port}`,
			status: InstanceStatus.BadConfig,
			http: http,
			reason: reason,
		})

		if (logged) {
			self.issueWarning('version', reason, self.WARNING_MS)
		}
	},

	/**
	 * Builds the pre-2.0 status message
	 *
	 * Example: `BreakTime 2.0 or later required, found 1.1.0 at 10.1.4.12:5165. For BreakTime 1.x,
	 * use module v1.0.3.` Without a version string it reads `found BreakTime 1.x`.
	 *
	 * @private
	 * @param {AttemptTarget} target - Attempt target
	 * @param {string} version - Version string BreakTime returned, or ''
	 * @returns {string} Status message
	 */
	buildUnsupportedMessage: function (target, version) {
		const found = version ? version : 'BreakTime 1.x'

		return (
			`BreakTime 2.0 or later required, found ${found} at ${target.host}:${target.port}. ` +
			'For BreakTime 1.x, use module v1.0.3.'
		)
	},

	/**
	 * Writes a `conn:` transition line unless the same condition was already logged
	 *
	 * Connection conditions are latched so a repeating condition logs once: every
	 * ConnectionFailure in a streak shares one latch (no line per reconnect attempt), while
	 * auth, unsupported and starting latch per reason. Logging a new condition clears the
	 * other `conn:` latches, so a change back to an earlier condition is logged again.
	 * `conn: connected` / `restored` clear them all (see `handleFirstFrame`).
	 *
	 * @private
	 * @param {'error'|'warn'|'info'} level - Log level
	 * @param {string} verb - `conn:` verb
	 * @param {Object<string, *>} fields - Log fields
	 * @returns {boolean} True when the line was written
	 */
	logConn: function (level, verb, fields) {
		let self = this

		const latch = verb === 'lost' ? 'conn:lost' : `conn:${verb}:${fields.reason}`

		if (self.logLatches.has(latch)) {
			return false
		}

		self.clearLogLatches('conn:')
		self.logLatches.add(latch)
		self.logEvent(level, 'conn', verb, fields)

		return true
	},

	/**
	 * Logs a failed non-gesture request (`rest: failed`) once until that path succeeds again
	 *
	 * @private
	 * @param {AttemptTarget} target - Attempt target
	 * @param {string} method - HTTP method
	 * @param {string} path - Request path
	 * @param {RestResult} result - The failed result
	 * @param {string} [reason] - Module-authored reason; derived from the result when omitted
	 * @returns {void}
	 */
	logRestFailure: function (target, method, path, result, reason) {
		let self = this

		const latch = `rest:${path}`

		if (self.logLatches.has(latch)) {
			return
		}

		self.logLatches.add(latch)
		self.logEvent('warn', 'rest', 'failed', {
			host: `${target.host}:${target.port}`,
			method: method,
			path: path,
			http: result.status || undefined,
			reason: reason ?? self.describeFailure(result),
			took: self.formatDuration(result.took),
		})
	},

	/**
	 * Removes every log latch whose name starts with a prefix
	 *
	 * @private
	 * @param {string} prefix - Latch name prefix, e.g. `conn:`
	 * @returns {void}
	 */
	clearLogLatches: function (prefix) {
		let self = this

		for (const latch of self.logLatches) {
			if (latch.startsWith(prefix)) {
				self.logLatches.delete(latch)
			}
		}
	},

	/**
	 * Describes a failed REST result in a short, stable, module-authored phrase
	 *
	 * Stable per cause, so a repeating failure never changes the status message.
	 *
	 * @private
	 * @param {RestResult} result - The failed result
	 * @returns {string} e.g. `BreakTime did not respond`, `Cannot reach BreakTime (ECONNREFUSED)` or `Unexpected response from BreakTime (HTTP 503)`
	 */
	describeFailure: function (result) {
		if (result.error === 'timeout') {
			return 'BreakTime did not respond'
		}

		if (result.error === 'network') {
			return `Cannot reach BreakTime (${result.errorText})`
		}

		return `Unexpected response from BreakTime (HTTP ${result.status})`
	},

	/**
	 * Describes a WebSocket error in a short, stable, module-authored phrase
	 *
	 * @private
	 * @param {Error & {code?: string}} error - Socket error
	 * @returns {string} e.g. `Cannot reach BreakTime (ECONNREFUSED)` or `Connection to BreakTime timed out`
	 */
	describeSocketError: function (error) {
		if (error?.code) {
			return `Cannot reach BreakTime (${error.code})`
		}

		if (/handshake has timed out/i.test(error?.message ?? '')) {
			return 'Connection to BreakTime timed out'
		}

		return error?.message ? `Connection error: ${error.message}` : 'Connection error'
	},

	/**
	 * Formats a duration for a log value: `<n>ms` below one second, otherwise whole seconds `<n>s`
	 *
	 * @private
	 * @param {number} ms - Duration in milliseconds
	 * @returns {string} Formatted duration
	 */
	formatDuration: function (ms) {
		return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${Math.round(ms / 1000)}s`
	},

	/**
	 * Builds the request headers shared by REST requests and the WebSocket handshake
	 *
	 * @private
	 * @param {string} apiKey - API key to send, or '' to send none
	 * @returns {Object<string, string>} Headers
	 */
	buildHeaders: function (apiKey) {
		const headers = { 'User-Agent': USER_AGENT }

		if (apiKey) {
			headers[API_KEY_HEADER] = apiKey
		}

		return headers
	},

	/**
	 * Applies one parsed state frame: normalizes it into DATA and pushes what changed
	 *
	 * Hot path: runs on every frame (about 1 per second, plus extra frames on changes). One
	 * pass over the playlist finds the armed event and the running events. The event list is
	 * compared in place without allocating, and the event choices (with the actions,
	 * feedbacks and presets that list events) are rebuilt only when the ordered ID and name
	 * list changes. `checkVariables()` then pushes only the variables that changed and
	 * re-checks only the affected feedback types.
	 *
	 * Normalization rules:
	 * - The armed event is the playlist's own entry whose `ID` matches `NextEvent.ID`. The
	 *   `NextEvent` object itself is never used: BreakTime leaves it pointing at a deleted
	 *   event (even with an empty playlist) until the next arm or start.
	 * - Running events are sorted newest first by `StartMS`, ties in playlist order;
	 *   `running[0]` is the latest running event. Each running event then holds a fixed
	 *   slot (`assignRunningSlots()`) that does not change while it runs.
	 * - SCTE 104 reads Connected when its Client or Server is Healthy and Disabled when both
	 *   are Disabled; vMix maps Healthy to Connected and Disabled to Disabled; anything else
	 *   is Disconnected. Only a Connected to Disconnected change raises the `scte104` / `vmix`
	 *   warning.
	 * - `scte104_*_event_id` come from `LastStartedEvent`: the splice ID only for Splice
	 *   Insert (`MessageMode` 0), the segmentation ID only for Time Signal (1), 0 as ''; the
	 *   other ID keeps its value. Both are '' while `LastStartedEvent` is null.
	 * - A pending Set Armed Duration target is dropped once a frame shows it, or after
	 *   PENDING_DURATION_MS.
	 * - Every component in COMPONENTS is mapped to its status name (a missing key is
	 *   Unknown) by `updateComponents()`, which also logs `state: component changed`.
	 * - `HA` is kept as received and `HARoleAlarm` as a string or null; `trackHa()` logs
	 *   `state: ha changed`. The `message` variable is recomputed on every push (see
	 *   `getMessageText()`), so an alarm going from non-null to null clears it at once.
	 * - `GlobalWarning` is one-shot: BreakTime clears it after each broadcast, so every
	 *   frame that carries a non-null value is a separate warning. Each one raises the
	 *   `global` warning and logs `state: global warning`, even when the text equals the
	 *   previous frame's.
	 *
	 * A frame that is valid JSON but not an object (`null`, an array, a string, a number or
	 * a boolean) is a frame error like the same frame first on a socket: it changes nothing,
	 * so no slot moves, nothing blanks and no definitions are rebuilt. `{}` is an object
	 * and is applied as an empty playlist.
	 *
	 * The whole body is wrapped: a throw would otherwise escape the WebSocket message
	 * handler and end the module process (base installs no `uncaughtException` handler). It
	 * is logged once as `state: frame error`, and the latch clears on the next clean pass.
	 *
	 * @param {StateFrame} data - Parsed state frame (PascalCase keys)
	 * @returns {void}
	 */
	processData: function (data) {
		let self = this

		if (!isFrameObject(data)) {
			self.logFrameError(new Error(MSG_FRAME_NOT_OBJECT))
			return
		}

		try {
			const DATA = self.DATA
			const playlistEvents = data.Playlist?.Events
			const events = Array.isArray(playlistEvents) ? playlistEvents : []
			const armedId = data.NextEvent?.ID ?? null
			const pending = self.pendingDuration

			let armed = undefined
			const running = []

			for (const event of events) {
				if (armedId !== null && event.ID === armedId) {
					armed = event
				}

				if (event.Status === 1) {
					running.push(event)
				}

				if (pending !== null && event.ID === pending.id && event.DurationSeconds === pending.seconds) {
					self.pendingDuration = null
				}
			}

			if (running.length > 1) {
				running.sort(compareStartDescending)
			}

			if (self.pendingDuration !== null && Date.now() >= self.pendingDuration.until) {
				self.pendingDuration = null
			}

			DATA.events = events
			DATA.selectedEvent = armed
			DATA.running = running
			DATA.runningEventsCount = running.length
			self.assignRunningSlots()
			DATA.ha = data.HA ?? null

			// Legacy SCTE 104 and vMix buckets (Status: 0 Disabled, 1 Unhealthy, 2 Warning, 3 Healthy)
			const components = data.ComponentStatuses
			const scte104Client = components?.['SCTE 104 Client']?.Status
			const scte104Server = components?.['SCTE 104 Server']?.Status
			const vmix = components?.vMix?.Status

			let scte104Status = 'Disconnected'

			if (scte104Client === 3 || scte104Server === 3) {
				scte104Status = 'Connected'
			} else if (scte104Client === 0 && scte104Server === 0) {
				scte104Status = 'Disabled'
			}

			const vmixStatus = vmix === 3 ? 'Connected' : vmix === 0 ? 'Disabled' : 'Disconnected'

			if (DATA.scte104Status === 'Connected' && scte104Status === 'Disconnected') {
				self.issueWarning('scte104', 'SCTE 104 has disconnected', self.WARNING_MS, true)
			}

			if (DATA.vmixStatus === 'Connected' && vmixStatus === 'Disconnected') {
				self.issueWarning('vmix', 'vMix has disconnected', self.WARNING_MS, true)
			}

			DATA.scte104Status = scte104Status
			DATA.vmixStatus = vmixStatus

			self.updateComponents(components)

			// HA and its role alarm
			const alarm = typeof data.HARoleAlarm === 'string' && data.HARoleAlarm !== '' ? data.HARoleAlarm : null

			DATA.haRoleAlarm = alarm
			self.trackHa(DATA.ha, alarm)

			// GlobalWarning is one-shot: BreakTime clears it after each broadcast
			const globalWarning =
				typeof data.GlobalWarning === 'string' && data.GlobalWarning !== '' ? data.GlobalWarning : null

			if (globalWarning !== null) {
				self.logEvent('warn', 'state', 'global warning', { detail: globalWarning })
				self.issueWarning('global', globalWarning, self.WARNING_MS, true)
			}

			// SCTE event IDs of the last started event
			const lastStarted = data.LastStartedEvent

			if (!lastStarted) {
				DATA.scte104SpliceEventID = ''
				DATA.scte104SegmentationEventID = ''
			} else if (lastStarted.MessageMode === 0) {
				DATA.scte104SpliceEventID = lastStarted.ActuationSpliceEventID || ''
			} else if (lastStarted.MessageMode === 1) {
				DATA.scte104SegmentationEventID = lastStarted.ActuationSegmentationEventID || ''
			}

			if (self.isEventListChanged(events)) {
				self.rebuildEventChoices(events)
			}

			self.checkVariables()
			self.logLatches.delete(LATCH_FRAME_ERROR)
		} catch (error) {
			self.logFrameError(error)
		}
	},

	/**
	 * Gives each running event a fixed running slot and fills `DATA.slotEvents`
	 *
	 * Hot path: runs on every frame, over the running events and the assignments only. An
	 * event keeps its slot until it stops running, so the `running_N_*` values of other
	 * events never move. In order:
	 * 1. Each running event that holds a slot within the configured count is placed in it.
	 * 2. Assignments whose event is no longer running, or whose slot is above the count
	 *    (after the count was lowered), are dropped, which frees those slots.
	 * 3. Running events without a slot take the lowest free slots, oldest first by
	 *    `StartMS` (ties in playlist order). When more events run than there are slots, the
	 *    extra ones have no slot: they stay in `running_events_json` and take the next slot
	 *    that frees up, oldest first. A fresh assignment (the first frame after the module
	 *    starts, or after a host or port change) is therefore oldest first.
	 *
	 * While the run state is unknown (WebSocket down) every slot reads empty and only step
	 * 2's count rule is applied: the other assignments wait for the first frame after
	 * reconnect, where an event still running keeps its slot. Also called by
	 * `handleDisconnect()` and, from the last frame, when the slot count changes.
	 * Allocates only when a running event has no slot and a slot is free.
	 *
	 * @returns {void}
	 */
	assignRunningSlots: function () {
		let self = this

		const DATA = self.DATA
		const assigned = DATA.slotByEventId
		const slotEvents = DATA.slotEvents
		const slots = self.getRunningSlotCount()

		slotEvents.length = slots
		slotEvents.fill(undefined)

		if (DATA.runningEventsCount === '') {
			for (const [eventId, slot] of assigned) {
				if (slot > slots) {
					assigned.delete(eventId)
				}
			}

			return
		}

		const running = DATA.running

		let placed = 0

		for (const event of running) {
			const slot = assigned.get(event.ID)

			if (slot !== undefined && slot <= slots) {
				slotEvents[slot - 1] = event
				placed++
			}
		}

		// An assignment survives only when its event was placed in its slot just now
		for (const [eventId, slot] of assigned) {
			if (slot > slots || slotEvents[slot - 1]?.ID !== eventId) {
				assigned.delete(eventId)
			}
		}

		if (placed === running.length || placed === slots) {
			return
		}

		const waiting = running.filter((event) => !assigned.has(event.ID)).sort(compareStartAscending)

		let free = 0

		for (const event of waiting) {
			while (free < slots && slotEvents[free] !== undefined) {
				free++
			}

			if (free === slots) {
				break
			}

			slotEvents[free] = event
			assigned.set(event.ID, free + 1)
		}
	},

	/**
	 * Updates every component's status from the frame and logs `state: component changed` on a transition
	 *
	 * Hot path: updates the `components` entries in place and allocates nothing while
	 * nothing changes. A component whose key is missing reads Unknown (Stream Health is
	 * absent while the Stream Injector is disabled or disconnected). The log baseline
	 * (`componentsSeen`) survives a disconnect, so a reconnect logs only real changes; on
	 * the first frame for a host only an Unhealthy component is logged. Levels: warn for a
	 * change to Unhealthy, debug for Healthy to Warning and back, info otherwise.
	 *
	 * @private
	 * @param {Object<string, {Status: number, StatusDetail: string}>|undefined} statuses - The frame's `ComponentStatuses`
	 * @returns {void}
	 */
	updateComponents: function (statuses) {
		let self = this

		const DATA = self.DATA

		for (const component of self.COMPONENTS) {
			const entry = statuses?.[component.key]
			const status = (entry && self.COMPONENT_STATUS_NAMES[entry.Status]) || 'Unknown'
			const detail = typeof entry?.StatusDetail === 'string' ? entry.StatusDetail : ''
			const state = DATA.components[component.slug]

			state.status = status
			state.detail = detail

			const seen = DATA.componentsSeen[component.slug]

			if (seen === status) {
				continue
			}

			DATA.componentsSeen[component.slug] = status

			if (seen === undefined && status !== 'Unhealthy') {
				continue
			}

			let level = 'info'

			if (status === 'Unhealthy') {
				level = 'warn'
			} else if (isHealthyOrWarning(seen) && isHealthyOrWarning(status)) {
				level = 'debug'
			}

			self.logEvent(level, 'state', 'component changed', {
				component: component.slug,
				from: seen ?? 'Unknown',
				to: status,
				detail: detail || undefined,
			})
		}
	},

	/**
	 * Logs `state: ha changed` when the HA role, acting flag, link state or role alarm changes
	 *
	 * Hot path: compares in place and allocates nothing while nothing changes. The line
	 * carries the current `role=`, `acting=` and `link=`, plus `detail=` with the role alarm
	 * while one is set (`detail=""` when it just cleared). The baseline (`haSeen`) survives
	 * a disconnect; on the first frame for a host the line is written only when the link is
	 * Degraded or an alarm is set, since `conn: connected` already carries role and acting.
	 * Level warn for a change to Degraded or when a new non-null role alarm appears (a
	 * different text counts as new), info otherwise (including the alarm clearing).
	 *
	 * @private
	 * @param {HaState|null} ha - The frame's `HA` object
	 * @param {string|null} alarm - The frame's `HARoleAlarm`, null when none
	 * @returns {void}
	 */
	trackHa: function (ha, alarm) {
		let self = this

		const role = ha?.Role
		const acting = ha?.Acting
		const link = ha?.LinkState
		const seen = self.DATA.haSeen

		if (
			seen !== null &&
			seen.role === role &&
			seen.acting === acting &&
			seen.link === link &&
			seen.alarm === alarm
		) {
			return
		}

		const first = seen === null
		const alarmCleared = !first && seen.alarm !== null && alarm === null
		const toDegraded = link === 'Degraded' && (first || seen.link !== 'Degraded')
		const newAlarm = alarm !== null && (first || seen.alarm !== alarm)

		if (first) {
			self.DATA.haSeen = { role: role, acting: acting, link: link, alarm: alarm }
		} else {
			seen.role = role
			seen.acting = acting
			seen.link = link
			seen.alarm = alarm
		}

		if (first && !toDegraded && alarm === null) {
			return
		}

		self.logEvent(toDegraded || newAlarm ? 'warn' : 'info', 'state', 'ha changed', {
			role: role,
			acting: acting,
			link: link,
			detail: alarm ?? (alarmCleared ? '' : undefined),
		})
	},

	/**
	 * Returns true when the ordered event ID and name list differs from the one the choices were built from
	 *
	 * Hot path: compares in place, without allocating. Always true after a new socket or a
	 * disconnect (the previous list is null), so the first frame of every connection
	 * rebuilds the choices from real data.
	 *
	 * @private
	 * @param {BreakTimeEvent[]} events - Playlist events from the current frame
	 * @returns {boolean} True when the choices must be rebuilt
	 */
	isEventListChanged: function (events) {
		const keys = this.eventListKeys

		if (keys === null || keys.length !== events.length * 2) {
			return true
		}

		for (let index = 0; index < events.length; index++) {
			if (keys[index * 2] !== events[index].ID || keys[index * 2 + 1] !== events[index].Name) {
				return true
			}
		}

		return false
	},

	/**
	 * Rebuilds the event choices and re-registers everything that lists events
	 *
	 * Expensive (actions, feedbacks and presets are all re-registered), so it runs only
	 * when `isEventListChanged()` says so. An empty playlist gives an empty list, never the
	 * "Loading Events..." placeholder, so event dropdowns then default to ''.
	 *
	 * Also prunes `tileFeedbacks`: a tile whose event is no longer in the playlist moves to
	 * `unlistedTileFeedbacks`, so the per-frame tile check skips it. `DATA.eventNames` is
	 * then pruned to the events in the playlist plus the removed events an unlisted tile
	 * still shows, so repeated XLS imports (new event IDs each time) cannot grow it without
	 * bound while a removed event's tile keeps its name. Every tile is then re-checked once
	 * (`checkFeedbacks('eventTile')`), which is what turns a pruned tile to "(removed)", and
	 * re-tracks a tile whose event came back (a JSON import keeps IDs). The tile callback
	 * tracks only listed events in `tileFeedbacks`, so the re-check never re-adds a pruned
	 * one. Playlist changes are rare, so the one extra check costs nothing per frame.
	 *
	 * @private
	 * @param {BreakTimeEvent[]} events - Playlist events from the current frame
	 * @returns {void}
	 */
	rebuildEventChoices: function (events) {
		let self = this

		const keys = []
		const choices = []
		const listed = new Set()

		for (const event of events) {
			keys.push(event.ID, event.Name)
			choices.push({ id: event.ID, label: event.Name || event.ID })
			listed.add(event.ID)
			self.DATA.eventNames.set(event.ID, event.Name)
		}

		self.eventListKeys = keys
		self.CHOICES_EVENTS = choices

		for (const [feedbackId, eventId] of self.tileFeedbacks) {
			if (!listed.has(eventId)) {
				self.tileFeedbacks.delete(feedbackId)
				self.unlistedTileFeedbacks.set(feedbackId, eventId)
			}
		}

		// Keep only the names a tile can still show, so XLS imports (new IDs each time)
		// cannot grow the name memory without bound
		const shown = new Set(self.unlistedTileFeedbacks.values())

		for (const eventId of self.DATA.eventNames.keys()) {
			if (!listed.has(eventId) && !shown.has(eventId)) {
				self.DATA.eventNames.delete(eventId)
			}
		}

		self.logEvent('debug', 'state', 'playlist changed', { count: events.length })

		self.initActions()
		self.initFeedbacks()
		self.initPresets()

		self.checkFeedbacks('eventTile')
	},

	/**
	 * Resolves an event named in an action option to the event to act on
	 *
	 * The option is a playlist event ID. While connected, an ID that is not in the playlist
	 * is refused locally. While not connected the cached list cannot be trusted, so an
	 * unknown ID is passed through for BreakTime to decide (it answers `EventNotFound`).
	 *
	 * @private
	 * @param {*} id - Option value
	 * @returns {{event: BreakTimeEvent|null, reason: string}} The event (possibly only `{ID}`), or null with the
	 *   local-guard reason
	 */
	resolveChosenEvent: function (id) {
		let self = this

		if (typeof id !== 'string' || id === '' || id === self.CHOICES_EVENTS_PLACEHOLDER[0].id) {
			return { event: null, reason: MSG_NO_EVENT_CHOSEN }
		}

		const event = self.DATA.events.find((entry) => entry.ID === id)

		if (event) {
			return { event: event, reason: '' }
		}

		if (self.isLive()) {
			return { event: null, reason: MSG_NOT_IN_PLAYLIST }
		}

		return { event: { ID: id }, reason: '' }
	},

	/**
	 * Returns the `ha` warning text for a gesture sent to a standby node, or '' on any other node
	 *
	 * HA standby rule: a node is standby only when `HA.Paired && !HA.Acting`. The request is
	 * still sent; the caller adds `acting=false` to its single action line and raises this
	 * text as an `ha` warning when the response raised no warning of its own.
	 *
	 * @private
	 * @param {'arm'|'duration'} kind - Gesture family
	 * @returns {string} Warning text, or ''
	 */
	getStandbyWarning: function (kind) {
		const ha = this.DATA.ha

		if (!ha || ha.Paired !== true || ha.Acting !== false) {
			return ''
		}

		return kind === 'arm' ? MSG_STANDBY_ARM : MSG_STANDBY_DURATION
	},

	/**
	 * Returns why the armed event's duration cannot be changed now, or '' when it can
	 *
	 * Shared by Armed Duration +/-, Set Armed Duration and the `IncDecNotAllowed` feedback:
	 * refused while the state is unknown (not connected), with nothing armed, for a Count Up
	 * event (BreakTime's 6 s floor would turn its 0 into a duration) or while the event runs.
	 *
	 * @returns {string} Local-guard reason, or ''
	 */
	getDurationBlock: function () {
		let self = this

		if (!self.isLive()) {
			return MSG_ARMED_UNKNOWN
		}

		const armed = self.DATA.selectedEvent

		if (!armed) {
			return MSG_NOTHING_ARMED
		}

		if (armed.DurationMode !== 0) {
			return 'Count Up events have no duration to change'
		}

		if (armed.Status === 1) {
			return `Cannot adjust this event's duration while "${armed.Name}" is running. End the event first.`
		}

		return ''
	},

	/**
	 * Returns the pending Set Armed Duration target for an event, or null when none is held
	 *
	 * Drops an expired target on read, so no timer is needed.
	 *
	 * @param {string} eventId - Event ID
	 * @returns {number|null} Seconds BreakTime accepted but no frame shows yet, or null
	 */
	getPendingDuration: function (eventId) {
		let self = this

		const pending = self.pendingDuration

		if (pending === null || pending.id !== eventId) {
			return null
		}

		if (Date.now() >= pending.until) {
			self.pendingDuration = null
			return null
		}

		return pending.seconds
	},

	/**
	 * Returns the armed event's duration in seconds, preferring a pending Set Armed Duration target
	 *
	 * The `armedDurationIs` feedback, the armed `eventTile` and the `selected_duration_*`
	 * and stopped `selected_time_*` variables read this, so the duration highlight and the
	 * Operator Panel START label follow a press at once instead of on the next frame.
	 *
	 * @returns {number|undefined} Duration in seconds, or undefined when nothing is armed
	 */
	getArmedDuration: function () {
		let self = this

		const armed = self.DATA.selectedEvent

		if (!armed) {
			return undefined
		}

		return self.getPendingDuration(armed.ID) ?? armed.DurationSeconds
	},

	/**
	 * Start Event: starts the armed event or a chosen one (`POST /api/playlist/events/{id}/start`)
	 *
	 * Local guards (nothing sent, `event` warning): a press within PRESS_DEBOUNCE_MS of the
	 * last start press that sent a request (checked first; see `reportPressDebounced()` for
	 * when its warning is held back); with the armed default, refused
	 * while not connected (the cached arm may be stale) or when nothing is armed; a chosen
	 * event that is not in the playlist; an event that is already running; and with
	 * `onlyWhenIdle`, any running event (or running state unknown). A chosen event stays
	 * allowed while not connected. Sends RequestState after an accepted start (so the
	 * advanced arm and the running event show at once) and after an unknown outcome.
	 *
	 * @async
	 * @param {Object} [options] - Action options; undefined values take their defaults
	 * @param {string} [options.event='armed'] - `armed`, or a playlist event ID
	 * @param {boolean} [options.immediate=false] - Fire immediately instead of with pre-roll
	 * @param {boolean} [options.onlyWhenIdle=false] - Refuse while any event is running
	 * @returns {Promise<void>}
	 */
	startSelected: async function (options) {
		let self = this

		const choice = options?.event ?? self.CHOICE_ARMED_EVENT.id
		const immediate = !!options?.immediate
		const onlyWhenIdle = !!options?.onlyWhenIdle

		if (self.isPressDebounced('start')) {
			self.reportPressDebounced('start', {})
			return
		}

		let event

		if (choice === self.CHOICE_ARMED_EVENT.id) {
			if (!self.isLive()) {
				self.reportNotSent('start', {}, 'event', MSG_ARMED_UNKNOWN)
				return
			}

			event = self.DATA.selectedEvent

			if (!event) {
				self.reportNotSent('start', {}, 'event', MSG_NOTHING_ARMED)
				return
			}
		} else {
			const resolved = self.resolveChosenEvent(choice)

			if (!resolved.event) {
				const id = resolved.reason === MSG_NOT_IN_PLAYLIST ? choice : undefined

				self.reportNotSent('start', { id: id }, 'event', resolved.reason)
				return
			}

			event = resolved.event
		}

		const fields = { event: event.Name, id: event.ID }

		if (event.Status === 1) {
			self.reportNotSent('start', fields, 'event', 'Event is already running')
			return
		}

		if (onlyWhenIdle && !self.isLive()) {
			self.reportNotSent('start', fields, 'event', MSG_RUNNING_UNKNOWN)
			return
		}

		if (onlyWhenIdle && self.DATA.running.length > 0) {
			self.reportNotSent('start', fields, 'event', 'Another event is already running')
			return
		}

		self.markPressSent('start')

		const result = await self.sendREST(`/api/playlist/events/${encodeURIComponent(event.ID)}/start`, {
			immediate: immediate,
		})

		const report = self.reportActionResult({ verb: 'start', kind: 'start', fields: fields }, result)

		if (report.accepted || report.unknown) {
			self.requestState()
		}
	},

	/**
	 * Start Armed Event: starts whatever BreakTime itself has armed (`POST /api/playlist/start`)
	 *
	 * Stays allowed while not connected: BreakTime reads its own arm. The log line names the
	 * event from `ack.eventId` (and that ID's name in the latest frame), never the local
	 * arm; without an `eventId` both keys are left out. `NothingArmed` and `EventNotFound`
	 * raise the `ack` warning like every other refusal. Its only local guard is the start
	 * press debounce, shared with Start Event. Sends RequestState after an accepted start
	 * (so the advanced arm shows at once) and after an unknown outcome.
	 *
	 * @async
	 * @param {Object} [options] - Action options; undefined values take their defaults
	 * @param {boolean} [options.immediate=false] - Fire immediately instead of with pre-roll
	 * @returns {Promise<void>}
	 */
	startArmed: async function (options) {
		let self = this

		if (self.isPressDebounced('start')) {
			self.reportPressDebounced('start armed', {})
			return
		}

		self.markPressSent('start')

		const result = await self.sendREST('/api/playlist/start', { immediate: !!options?.immediate })

		const report = self.reportActionResult({ verb: 'start armed', kind: 'startArmed', fields: {} }, result)

		if (report.accepted || report.unknown) {
			self.requestState()
		}
	},

	/**
	 * End Running Event: ends the latest running event, all of them, or a chosen one
	 *
	 * A press within PRESS_DEBOUNCE_MS of the last end press that sent a request, whatever
	 * its target, is refused first (nothing sent, `event` warning unless another warning is
	 * showing, see `reportPressDebounced()`). `latest` and `all` read
	 * the running events from the last frame, so they are refused locally while not
	 * connected; `specific` stays allowed then (BreakTime answers
	 * `AlreadyInThatState`, log-only, when the event is not running). Nothing running, or a
	 * `specific` event that is not running, is refused locally with an `event` warning. `all`
	 * posts every end concurrently, logs one line per event and raises one combined warning.
	 * RequestState is sent at most once: when at least one end was accepted or its outcome
	 * is unknown.
	 *
	 * @async
	 * @param {Object} [options] - Action options; undefined values take their defaults
	 * @param {string} [options.target='latest'] - `latest`, `all` or `specific`
	 * @param {string} [options.event] - Playlist event ID, used with `specific`
	 * @param {boolean} [options.immediate=false] - End immediately instead of with pre-roll
	 * @returns {Promise<void>}
	 */
	endSelected: async function (options) {
		let self = this

		const target = options?.target === 'all' || options?.target === 'specific' ? options.target : 'latest'
		const immediate = !!options?.immediate

		if (self.isPressDebounced('end')) {
			self.reportPressDebounced('end', { target: target })
			return
		}

		/** @type {Object[]} */
		let targets

		if (target === 'specific') {
			const resolved = self.resolveChosenEvent(options?.event)

			if (!resolved.event) {
				const id = resolved.reason === MSG_NOT_IN_PLAYLIST ? options.event : undefined

				self.reportNotSent('end', { target: target, id: id }, 'event', resolved.reason)
				return
			}

			if (self.isLive() && resolved.event.Status !== 1) {
				self.reportNotSent(
					'end',
					{ target: target, event: resolved.event.Name, id: resolved.event.ID },
					'event',
					'Event is not running',
				)
				return
			}

			targets = [resolved.event]
		} else {
			if (!self.isLive()) {
				self.reportNotSent('end', { target: target }, 'event', MSG_RUNNING_UNKNOWN)
				return
			}

			if (self.DATA.running.length === 0) {
				self.reportNotSent('end', { target: target }, 'event', 'No event is running')
				return
			}

			targets = target === 'all' ? self.DATA.running.slice() : [self.DATA.running[0]]
		}

		const deferWarning = targets.length > 1

		self.markPressSent('end')

		const settled = await Promise.allSettled(
			targets.map((event) =>
				self.sendREST(`/api/playlist/events/${encodeURIComponent(event.ID)}/end`, { immediate: immediate }),
			),
		)

		/** @type {WarningSpec[]} */
		const warnings = []
		let refresh = false

		settled.forEach((outcome, index) => {
			const event = targets[index]
			const result = outcome.status === 'fulfilled' ? outcome.value : null

			const report = self.reportActionResult(
				{
					verb: 'end',
					kind: 'end',
					fields: { target: target, event: event.Name, id: event.ID },
					deferWarning: deferWarning,
				},
				result,
			)

			if (report.accepted || report.unknown) {
				refresh = true
			}

			if (report.warning) {
				warnings.push(report.warning)
			}
		})

		if (warnings.length === 1) {
			self.issueWarning(warnings[0].type, warnings[0].text, self.WARNING_MS)
		} else if (warnings.length > 1) {
			self.issueWarning(
				warnings[0].type,
				`${warnings.length} of ${targets.length} ends: ${warnings[0].text}`,
				self.WARNING_MS,
			)
		}

		if (refresh) {
			self.requestState()
		}
	},

	/**
	 * Returns true when a Start (or End) press falls within PRESS_DEBOUNCE_MS of the last press of its group that sent a request
	 *
	 * Hot path of every Start and End press: one clock read and a compare. The clock is
	 * monotonic (`performance.now()`), so a wall-clock step cannot hold the window open. An
	 * ignored press does not move the window: only `markPressSent()` does.
	 *
	 * @param {'start'|'end'} group - `start` (Start Event and Start Armed Event) or `end` (End Running Event)
	 * @returns {boolean} True when the press must be ignored
	 */
	isPressDebounced: function (group) {
		const sentAt = this.pressSentAt[group]

		return sentAt !== null && performance.now() - sentAt < PRESS_DEBOUNCE_MS
	},

	/**
	 * Opens the press debounce window of a group: call just before a Start (or End) press sends its request
	 *
	 * @param {'start'|'end'} group - `start` or `end`
	 * @returns {void}
	 */
	markPressSent: function (group) {
		this.pressSentAt[group] = performance.now()
	},

	/**
	 * Logs an ignored Start (or End) press, raising the `event` warning only when no other warning is showing
	 *
	 * Always writes the one `outcome=NotSent` action line. The warning slot holds one
	 * warning and the newest wins, so a double-tap would otherwise replace the first press's
	 * answer (a BreakTime refusal, or "Nothing sent" when a start acted but did not emit)
	 * with the short "Pressed again" warning and leave nothing on screen once it expires.
	 * An active warning of any other type is therefore kept for its full time; an active
	 * `event` warning is replaced as usual.
	 *
	 * @param {string} verb - `action:` verb (`start`, `start armed` or `end`)
	 * @param {Object<string, *>} fields - Leading log fields
	 * @returns {void}
	 */
	reportPressDebounced: function (verb, fields) {
		let self = this

		const keep = self.DATA.temporaryWarning && self.DATA.temporaryWarningType !== 'event'

		self.reportNotSent(verb, fields, keep ? null : 'event', MSG_PRESSED_AGAIN)
	},

	/**
	 * Closes both press debounce windows, so the next Start or End press acts at once
	 *
	 * Called when the connection is lost and when the host or port changes: a press made
	 * then belongs to a new connection, not to the press before it.
	 *
	 * @returns {void}
	 */
	releasePressWindows: function () {
		this.pressSentAt.start = null
		this.pressSentAt.end = null
	},

	/**
	 * Arm Next: arms the event after the armed one, wrapping from the last to the first
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	selectNextEvent: async function () {
		await this.stepArm(1)
	},

	/**
	 * Arm Previous: arms the event before the armed one, wrapping from the first to the last
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	selectPreviousEvent: async function () {
		await this.stepArm(-1)
	},

	/**
	 * Arms the playlist neighbor of the armed event, wrapping at both ends
	 *
	 * Rapid presses step from the pending-arm target (the latest target of the arm request
	 * in flight, see `armEvent()`) when one is set, otherwise from the frame's armed ID, so
	 * three quick presses end three events on, without a blocking promise chain. When the
	 * armed event is unknown (nothing armed, or a deleted event still named by
	 * `NextEvent`), Next arms the first event and Previous the last. An empty playlist sends
	 * nothing.
	 *
	 * @private
	 * @async
	 * @param {1|-1} direction - 1 for Next, -1 for Previous
	 * @returns {Promise<void>}
	 */
	stepArm: async function (direction) {
		let self = this

		const verb = direction > 0 ? 'arm next' : 'arm previous'
		const events = self.DATA.events

		if (events.length === 0) {
			self.reportNotSent(verb, {}, 'event', self.isLive() ? 'Playlist is empty' : MSG_ARMED_UNKNOWN)
			return
		}

		const fromId = self.pendingArmId ?? self.DATA.selectedEvent?.ID
		const index = fromId === undefined ? -1 : events.findIndex((event) => event.ID === fromId)

		let nextIndex

		if (index < 0) {
			nextIndex = direction > 0 ? 0 : events.length - 1
		} else {
			nextIndex = (index + direction + events.length) % events.length
		}

		await self.armEvent(verb, events[nextIndex])
	},

	/**
	 * Arm Event: arms the event chosen in the action's `event` option
	 *
	 * @async
	 * @param {Object} [options] - Action options
	 * @param {string} [options.event] - Playlist event ID
	 * @returns {Promise<void>}
	 */
	selectEvent: async function (options) {
		let self = this

		const resolved = self.resolveChosenEvent(options?.event)

		if (!resolved.event) {
			const id = resolved.reason === MSG_NOT_IN_PLAYLIST ? options.event : undefined

			self.reportNotSent('arm', { id: id }, 'event', resolved.reason)
			return
		}

		await self.armEvent('arm', resolved.event)
	},

	/**
	 * Arms one event (`POST /api/playlist/next-event`): single-flight, coalescing to the latest target
	 *
	 * At most one arm request is in flight. The first press sends its target and its
	 * callback awaits only that request. A press made while a request is in flight is
	 * folded in: it records its target as the latest one and returns at once, sending
	 * nothing. When the request settles (ack, error or timeout), `runArmRequest()` sends
	 * one request for the latest target if it differs from the target just sent. There is
	 * no request queue and no blocking chain: three quick Arm Next presses send at most two
	 * requests and end three events on, never out of order. Arm Event joins the same flight.
	 *
	 * `pendingArmId` holds the latest target from the first press until the last request
	 * settles, so Arm Next / Previous step from it. The frame stays the source of truth for
	 * the arm (on a standby node FollowPeerArm may overwrite it). A throw from the request
	 * (not expected) resets the flight and `pendingArmId` and is logged once through the
	 * frame-error latch, so the next press starts a fresh flight instead of folding into a
	 * dead one.
	 *
	 * Logging rule, one `action:` line per gesture: the press whose target a request
	 * carries logs that request's line and raises its warning. A folded press logs its own
	 * line, naming its own target as `event=`/`id=`, with the outcome of the request it
	 * folded into (`outcome=Accepted` when that request was accepted, otherwise that
	 * request's outcome). When that request carried a different event, the line adds
	 * `to=<that request's event ID>` and leaves out `detail=` (BreakTime's text about the
	 * other event): the outcome belongs to the `to=` event, and this press's own event was
	 * never sent. `http=` and `reason=` are copied (module-authored, not event-specific). It
	 * raises no warning, so one request shows one warning. A press folds into the next
	 * request sent after it, or, when none is needed because the latest target equals the
	 * target just sent, into the request that was in flight (never into a request sent to
	 * the previous server before a host or port change). Its `took=` runs from the press to
	 * that request's answer. The lines normally follow press order.
	 *
	 * @private
	 * @async
	 * @param {string} verb - `action:` verb (`arm`, `arm next` or `arm previous`)
	 * @param {{ID: string, Name?: string}} event - Event to arm
	 * @returns {Promise<void>} Settles when this press's own request answered, or at once for a folded press
	 */
	armEvent: async function (verb, event) {
		let self = this

		/** @type {ArmPress} */
		const press = {
			verb: verb,
			event: event,
			standbyWarning: self.getStandbyWarning('arm'),
			started: Date.now(),
		}

		self.pendingArmId = event.ID

		if (self.armFlight !== null) {
			self.armFlight.waiting.push(press)
			return
		}

		self.armFlight = { waiting: [], dropped: false }

		try {
			await self.runArmRequest(press, [])
		} catch (error) {
			// Not expected: sendREST and reportActionResult never throw. Reset the flight as
			// the chained request's .catch does, so a throw can never leave every later arm
			// press folded into a flight that no longer exists.
			self.armFlight = null
			self.pendingArmId = null
			self.logFrameError(error)
		}
	},

	/**
	 * Sends one arm request, reports it, then sends the latest folded-in target if it differs
	 *
	 * `lead` is the press whose target this request carries; `folded` are the presses that
	 * folded into it. After the answer: the lead's line is logged (with its warning) by
	 * `reportActionResult`, each folded press logs its own line just before it (they were
	 * made earlier, so lines follow press order), and RequestState is sent when the outcome
	 * is unknown (the arm may have changed). The presses that arrived meanwhile are then
	 * taken: when the last one's target differs from this request's, or the flight was
	 * dropped by a host or port change (this request went to the previous server), a
	 * request for it starts in a fresh flight (not awaited: its press's callback already
	 * returned), with the others folded into it. Otherwise they fold into this request, the
	 * flight ends, `pendingArmId` is cleared, and an accepted `ack.eventId` is applied as an
	 * optimistic arm until the next frame (only when the flight was not dropped and the
	 * request belongs to the current connection attempt). Every settle path is a no-op
	 * after `destroy()`.
	 *
	 * @private
	 * @async
	 * @param {ArmPress} lead - Press whose target this request carries
	 * @param {ArmPress[]} folded - Presses that folded into this request, in press order
	 * @returns {Promise<void>}
	 */
	runArmRequest: async function (lead, folded) {
		let self = this

		const result = await self.sendREST('/api/playlist/next-event', { nextEventID: lead.event.ID })

		if (self.destroyed) {
			return
		}

		const report = self.reportActionResult(
			{
				verb: lead.verb,
				kind: 'arm',
				fields: { event: lead.event.Name, id: lead.event.ID },
				acting: lead.standbyWarning ? false : undefined,
				standbyWarning: lead.standbyWarning,
				beforeLog: (settled) => {
					// The folded presses came before the lead press: log them first
					for (const press of folded) {
						self.logFoldedArm(press, lead.event.ID, settled)
					}
				},
			},
			result,
		)

		if (report.unknown) {
			self.requestState()
		}

		const flight = self.armFlight
		const waiting = flight.waiting
		const next = waiting.at(-1)

		flight.waiting = []

		// After a host or port change this request went to the previous server, so a press
		// made since then is sent even when it names the same event ID (as on an HA pair)
		if (next !== undefined && (flight.dropped || next.event.ID !== lead.event.ID)) {
			if (flight.dropped) {
				self.armFlight = { waiting: [], dropped: false }
			}

			self.runArmRequest(next, waiting.slice(0, -1)).catch((error) => {
				// Not expected: sendREST and reportActionResult never throw. Contain it, since
				// this chain is not awaited and an unhandled rejection ends the process.
				self.armFlight = null
				self.pendingArmId = null
				self.logFrameError(error)
			})
			return
		}

		for (const press of waiting) {
			self.logFoldedArm(press, lead.event.ID, report)
		}

		self.armFlight = null
		self.pendingArmId = null

		if (report.accepted && !flight.dropped && result.gen === self.attemptGen) {
			const armed = self.DATA.events.find((entry) => entry.ID === report.ack?.eventId)

			if (armed && armed !== self.DATA.selectedEvent) {
				self.DATA.selectedEvent = armed
				self.refreshState()
			}
		}
	},

	/**
	 * Logs the `action:` line of an arm press that folded into another press's request
	 *
	 * Names the press's own target and, when the request it folded into carried a different
	 * event, that request's event ID as `to=`, so a parser reads the outcome as belonging
	 * to the `to=` event, never to this press's own `id=`. Copies only that request's
	 * `outcome=`, `http=` and `reason=` (module-authored, not event-specific); BreakTime's
	 * `detail=` text is about the event that request carried, so it is left out whenever
	 * that event differs. Raises no warning (see the logging rule in `armEvent()`).
	 *
	 * @private
	 * @param {ArmPress} press - The folded press
	 * @param {string} sentId - Event ID the request it folded into carried
	 * @param {ActionReport} report - Report of the request it folded into
	 * @returns {void}
	 */
	logFoldedArm: function (press, sentId, report) {
		let self = this

		if (report.logFields === null) {
			return
		}

		const redirected = press.event.ID !== sentId

		self.logEvent(report.accepted ? 'info' : 'warn', 'action', press.verb, {
			event: press.event.Name,
			id: press.event.ID,
			to: redirected ? sentId : undefined,
			outcome: report.logFields.outcome,
			http: report.logFields.http,
			reason: report.logFields.reason,
			detail: redirected ? undefined : report.logFields.detail,
			acting: press.standbyWarning ? false : undefined,
			took: self.formatDuration(Date.now() - press.started),
		})
	},

	/**
	 * Drops the arm presses still waiting to be sent, logging each as not sent
	 *
	 * Called by index.js on a host or port change: a waiting target was picked from the old
	 * server's playlist and must not be sent to the new one. The request already in flight
	 * settles normally (it went to the old server). The flight is marked dropped, so a press
	 * made after this call never folds into that old request, even when it names the same
	 * event ID: when the old request settles, the latest such press is sent to the new
	 * server as a new request, with the others folded into it. Each dropped press logs
	 * `outcome=NotSent` with no warning.
	 *
	 * @returns {void}
	 */
	dropWaitingArms: function () {
		let self = this

		const flight = self.armFlight

		if (flight === null) {
			return
		}

		for (const press of flight.waiting) {
			self.reportNotSent(press.verb, { event: press.event.Name, id: press.event.ID }, null, MSG_ARM_DROPPED)
		}

		flight.waiting = []
		flight.dropped = true
		self.pendingArmId = null
	},

	/**
	 * Armed Duration +: lengthens the armed event's duration
	 *
	 * @async
	 * @param {Object} [options] - Action options
	 * @param {string|number} [options.duration='5'] - Whole seconds to add, 1 to 65535 (variables already parsed
	 *   by Companion)
	 * @returns {Promise<void>}
	 */
	increaseDuration: async function (options) {
		await this.changeDuration('increaseDuration', 1, options?.duration ?? '5')
	},

	/**
	 * Armed Duration -: shortens the armed event's duration
	 *
	 * @async
	 * @param {Object} [options] - Action options
	 * @param {string|number} [options.duration='5'] - Whole seconds to subtract, 1 to 65535 (variables already
	 *   parsed by Companion)
	 * @returns {Promise<void>}
	 */
	decreaseDuration: async function (options) {
		await this.changeDuration('decreaseDuration', -1, options?.duration ?? '5')
	},

	/**
	 * Posts a signed duration delta for the armed event (`POST /api/playlist/events/{id}/duration`)
	 *
	 * Refused locally per `getDurationBlock()`, and for an amount that is not a whole
	 * number from 1 to 65535 (a stored 1.0.3 number converts the same way). BreakTime
	 * clamps the result (6 s floor, 6553 s / 65535 s ceilings), so the module does no
	 * client-side clamping of the request and never mutates its cached event. The expected
	 * result (base plus delta, clamped like BreakTime) is held as the pending duration
	 * synchronously before the request, so an overlapping press or a following Set Armed
	 * Duration computes from it; `settlePendingDuration` restores or drops it on a refusal.
	 * On a standby node the line carries `acting=false` and the `ha` warning is raised
	 * (duration changes are not replicated).
	 *
	 * @private
	 * @async
	 * @param {'increaseDuration'|'decreaseDuration'} warningType - Warning type for refusals
	 * @param {1|-1} sign - Direction
	 * @param {*} amount - Option value: whole seconds as text (or a number from a 1.0.3 button)
	 * @returns {Promise<void>}
	 */
	changeDuration: async function (warningType, sign, amount) {
		let self = this

		const armed = self.DATA.selectedEvent
		const fields = armed ? { event: armed.Name, id: armed.ID } : {}
		const block = self.getDurationBlock()

		if (block) {
			self.reportNotSent('duration', fields, warningType, block)
			return
		}

		const seconds = typeof amount === 'string' && amount.trim() === '' ? NaN : Number(amount)

		if (!Number.isInteger(seconds) || seconds < 1 || seconds > DURATION_STEP_MAX_S) {
			self.reportNotSent(
				'duration',
				fields,
				warningType,
				`Seconds must be a whole number from 1 to ${DURATION_STEP_MAX_S}`,
			)
			return
		}

		const delta = sign * seconds
		const base = self.getPendingDuration(armed.ID) ?? armed.DurationSeconds
		const standbyWarning = self.getStandbyWarning('duration')
		const previous = self.pendingDuration
		const entry = Number.isFinite(base)
			? self.setPendingDuration(armed.ID, clampDuration(base + delta, armed.MessageMode))
			: null

		fields.delta = delta

		const result = await self.sendREST(`/api/playlist/events/${encodeURIComponent(armed.ID)}/duration`, {
			delta: delta,
		})

		const report = self.reportActionResult(
			{
				verb: 'duration',
				kind: 'duration',
				fields: fields,
				warningType: warningType,
				acting: standbyWarning ? false : undefined,
				standbyWarning: standbyWarning,
			},
			result,
		)

		if (entry !== null) {
			self.settlePendingDuration(entry, previous, report.accepted)
		}
	},

	/**
	 * Set Armed Duration: sets the armed event's duration to an absolute number of seconds
	 *
	 * Sends `delta = target - current`, where current is the pending duration of a press
	 * still unconfirmed by a frame, otherwise the frame's `DurationSeconds`. The target is
	 * held as pending synchronously before the request (and restored on a refusal), so a
	 * fast second press computes from it and never applies the delta twice. Same local
	 * guards as Armed Duration +/-, plus a target outside 6..6553 (Splice Insert) or
	 * 6..65535 (Time Signal), matching BreakTime's clamps. A delta of 0 sends nothing and
	 * raises no warning (`outcome=NotSent reason="Already set"`). Logged as
	 * `action: duration` with `delta=` and the target as `to=`.
	 *
	 * Warning type: `increaseDuration` when the target is at or above the current duration,
	 * `decreaseDuration` below it, and `event` when no current duration or no valid target
	 * is known.
	 *
	 * @async
	 * @param {Object} [options] - Action options
	 * @param {string|number} [options.seconds='60'] - Target duration in whole seconds (variables already parsed
	 *   by Companion)
	 * @returns {Promise<void>}
	 */
	setArmedDuration: async function (options) {
		let self = this

		const amount = options?.seconds ?? '60'
		const seconds = typeof amount === 'string' && amount.trim() === '' ? NaN : Number(amount)
		const valid = Number.isInteger(seconds)
		const armed = self.DATA.selectedEvent
		const base = armed ? (self.getPendingDuration(armed.ID) ?? armed.DurationSeconds) : undefined

		let warningType = 'event'

		if (valid && Number.isFinite(base)) {
			warningType = seconds >= base ? 'increaseDuration' : 'decreaseDuration'
		}

		const fields = armed ? { event: armed.Name, id: armed.ID } : {}
		const block = self.getDurationBlock()

		if (block) {
			self.reportNotSent('duration', { ...fields, to: valid ? seconds : undefined }, warningType, block)
			return
		}

		if (!valid) {
			self.reportNotSent('duration', fields, warningType, 'Duration must be a whole number of seconds')
			return
		}

		const max = armed.MessageMode === 1 ? DURATION_MAX_TIME_SIGNAL_S : DURATION_MAX_SPLICE_S

		if (seconds < DURATION_MIN_S || seconds > max) {
			self.reportNotSent(
				'duration',
				{ ...fields, to: seconds },
				warningType,
				`Duration must be from ${DURATION_MIN_S} to ${max} seconds`,
			)
			return
		}

		const delta = seconds - base

		fields.delta = delta
		fields.to = seconds

		if (delta === 0) {
			self.reportNotSent('duration', fields, null, 'Already set')
			return
		}

		const standbyWarning = self.getStandbyWarning('duration')
		const previous = self.pendingDuration
		const entry = self.setPendingDuration(armed.ID, seconds)

		const result = await self.sendREST(`/api/playlist/events/${encodeURIComponent(armed.ID)}/duration`, {
			delta: delta,
		})

		const report = self.reportActionResult(
			{
				verb: 'duration',
				kind: 'duration',
				fields: fields,
				warningType: warningType,
				acting: standbyWarning ? false : undefined,
				standbyWarning: standbyWarning,
			},
			result,
		)

		self.settlePendingDuration(entry, previous, report.accepted)
	},

	/**
	 * Holds a duration BreakTime accepted (or is about to apply) until a frame shows it, or PENDING_DURATION_MS
	 *
	 * Called synchronously before the duration request is awaited, so an overlapping press
	 * computes its base from this target. Pushes state, so a feedback reading
	 * `getArmedDuration()` follows at once.
	 *
	 * @private
	 * @param {string} eventId - Event ID
	 * @param {number} seconds - Expected duration in seconds
	 * @returns {PendingDuration} The new pending entry, for `settlePendingDuration`
	 */
	setPendingDuration: function (eventId, seconds) {
		let self = this

		const entry = { id: eventId, seconds: seconds, until: Date.now() + PENDING_DURATION_MS }

		self.pendingDuration = entry
		self.refreshState()

		return entry
	},

	/**
	 * Settles a pending duration once its request has an answer
	 *
	 * Ownership is by entry identity, so a frame that already confirmed it (cleared) or a
	 * later press that replaced it is left alone on success. Accepted and still current:
	 * the hold restarts from now, as the change has only just been applied. Refused and
	 * still current: the previous entry is restored. Refused after a later press on the same
	 * event replaced it: that press computed its target from this refused one, so the held
	 * value is wrong by this delta and is dropped, letting frames show the real duration.
	 * A no-op after `destroy()`.
	 *
	 * @private
	 * @param {PendingDuration} entry - Entry `setPendingDuration` returned for this press
	 * @param {PendingDuration|null} previous - Entry held before this press
	 * @param {boolean} accepted - True when BreakTime accepted the change
	 * @returns {void}
	 */
	settlePendingDuration: function (entry, previous, accepted) {
		let self = this

		if (self.destroyed) {
			return
		}

		const current = self.pendingDuration

		if (accepted) {
			if (current === entry) {
				entry.until = Date.now() + PENDING_DURATION_MS
			}

			return
		}

		if (current === entry) {
			self.pendingDuration = previous
			self.refreshState()
		} else if (current !== null && current.id === entry.id) {
			self.pendingDuration = null
			self.refreshState()
		}
	},

	/**
	 * Shows a temporary warning on the Companion UI
	 *
	 * Sets the warning text, flag and type and pushes the change (the `temporaryWarning`
	 * feedback and the variables, through change detection), then clears all three after
	 * `duration`. The text is stored in its own field: `message` is computed from it by
	 * `getMessageText()` on every push, so on expiry `message` falls back to the current
	 * `HARoleAlarm` instead of going blank. A new warning replaces the active one and its
	 * timer, so timers never stack. Does not log: the caller's single log line
	 * (`<area>: <verb> key=value`) is the only line for the condition. Both pushes go
	 * through `refreshState()`, because a throw in the timer callback would end the module
	 * process. The expiry does nothing after `destroy()`.
	 *
	 * @param {string} type - Warning type, matched by the `temporaryWarning` feedback
	 * @param {string} message - Warning text
	 * @param {number} [duration] - Milliseconds before the warning clears; WARNING_MS when omitted
	 * @param {boolean} [deferPush=false] - True from `processData()`, which pushes once at the end of the frame
	 * @returns {void}
	 */
	issueWarning: function (type, message, duration, deferPush = false) {
		let self = this

		if (self.destroyed) {
			return
		}

		if (self.WARNING_TIMEOUT) {
			clearTimeout(self.WARNING_TIMEOUT)
			self.WARNING_TIMEOUT = null
		}

		self.DATA.warningText = message
		self.DATA.temporaryWarning = true
		self.DATA.temporaryWarningType = type

		if (!deferPush) {
			self.refreshState()
		}

		self.WARNING_TIMEOUT = setTimeout(() => {
			self.WARNING_TIMEOUT = null

			if (self.destroyed) {
				return
			}

			self.DATA.warningText = ''
			self.DATA.temporaryWarning = false
			self.DATA.temporaryWarningType = undefined

			self.refreshState()
		}, duration ?? self.WARNING_MS)
	},

	/**
	 * Tears down the WebSocket and cancels every pending re-attempt
	 *
	 * Bumps the attempt generation so any in-flight attempt continuation sees itself as
	 * stale. Listeners are removed before `terminate()`, so the socket's close handler
	 * cannot overwrite the status or schedule a reconnect; the no-op `error` handler keeps
	 * a late socket error from becoming an uncaught exception. Never changes the status.
	 *
	 * @returns {void}
	 */
	closeConnection: function () {
		let self = this

		self.attemptGen++

		if (self.WS) {
			const ws = self.WS
			self.WS = null
			ws.removeAllListeners()
			ws.on('error', () => {})
			ws.terminate()
		}

		if (self.WATCHDOG_TIMEOUT) {
			clearTimeout(self.WATCHDOG_TIMEOUT)
			self.WATCHDOG_TIMEOUT = null
		}

		if (self.RETRY_TIMEOUT) {
			clearTimeout(self.RETRY_TIMEOUT)
			self.RETRY_TIMEOUT = null
		}
	},

	/**
	 * Reports the connection status to Companion, only when it changes
	 *
	 * The single caller of `updateStatus` in the module: Companion logs every
	 * `updateStatus` call, so repeating an unchanged status or message would spam the log.
	 * Ignored after `destroy()`.
	 *
	 * @param {import('@companion-module/base').InstanceStatus} status - New connection status
	 * @param {string|null} [message] - Status message; omitted or null for none
	 * @returns {void}
	 */
	setStatus: function (status, message = null) {
		let self = this

		if (self.destroyed) {
			return
		}

		message = message ?? null

		if (status === self.lastStatus && message === self.lastStatusMessage) {
			return
		}

		self.lastStatus = status
		self.lastStatusMessage = message
		self.updateStatus(status, message)
	},

	/**
	 * Writes one log line in the module's `<area>: <verb> key=value ...` convention
	 *
	 * Fields whose value is undefined or null are left out. Debug lines are written only
	 * when Verbose Logging is on. Example output:
	 * `config: applied module=2.0.0 host=10.1.4.12:5165 key=set slots=4`
	 *
	 * @param {'error'|'warn'|'info'|'debug'} level - Companion log level
	 * @param {string} area - Log area, e.g. `config` or `conn`
	 * @param {string} verb - Verb from that area's closed list, e.g. `applied`
	 * @param {Object<string, *>} [fields] - Key/value pairs from the fixed key vocabulary, in output order
	 * @returns {void}
	 */
	logEvent: function (level, area, verb, fields = {}) {
		let self = this

		if (level === 'debug' && !self.config.verbose) {
			return
		}

		let line = `${area}: ${verb}`

		for (const key in fields) {
			const value = fields[key]

			if (value !== undefined && value !== null) {
				line += ` ${key}=${self.formatLogValue(key, value)}`
			}
		}

		self.log(level, line)
	},

	/**
	 * Formats one log value, quoting and escaping it when the convention requires
	 *
	 * `event`, `reason` and `detail` are always quoted; any other value is quoted only when
	 * it is empty or contains whitespace, `"` or `=`. `detail` is capped at `LOG_DETAIL_MAX`
	 * characters before escaping, counted in code points, so the cut never splits an emoji
	 * or other character outside the Basic Multilingual Plane into a broken half.
	 *
	 * @private
	 * @param {string} key - Field key
	 * @param {*} value - Field value; converted with `String()`
	 * @returns {string} The value ready to follow `key=`
	 */
	formatLogValue: function (key, value) {
		let self = this

		let text = String(value)

		// Cheap length check first: UTF-16 length is never below the code point count
		if (key === 'detail' && text.length > self.LOG_DETAIL_MAX) {
			let end = 0

			for (let count = 0; count < self.LOG_DETAIL_MAX && end < text.length; count++) {
				end += text.codePointAt(end) > 0xffff ? 2 : 1
			}

			text = text.slice(0, end)
		}

		if (key !== 'event' && key !== 'reason' && key !== 'detail' && text !== '' && !/[\s"=]/.test(text)) {
			return text
		}

		const escaped = text
			.replace(/\\/g, '\\\\')
			.replace(/"/g, '\\"')
			.replace(/\r\n|\r|\n/g, '\\n')

		return `"${escaped}"`
	},

	/**
	 * Sends a text command on the WebSocket, only while it is open
	 *
	 * A failed send means the socket is broken: it is terminated with the failure as the
	 * close reason, so the close handler logs it once and owns the status and reconnect.
	 *
	 * @param {string} command - Command text, e.g. `RequestState`
	 * @returns {boolean} True when the command was handed to the socket
	 */
	sendWSCommand: function (command) {
		let self = this

		const ws = self.WS

		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return false
		}

		const fail = (error) => {
			if (ws !== self.WS) {
				return
			}

			if (!self.closeReason) {
				self.closeReason = `Could not send to BreakTime: ${error?.message ?? String(error)}`
			}

			ws.terminate()
		}

		try {
			ws.send(command, (error) => {
				if (error) {
					fail(error)
				}
			})
		} catch (error) {
			fail(error)
			return false
		}

		return true
	},

	/**
	 * Asks BreakTime for an immediate full state frame, when the WebSocket is open
	 *
	 * BreakTime broadcasts that frame to every connected client, dashboards included, so
	 * this is sent only at the RequestState points (socket open, an accepted Start or End,
	 * outcome unknown), never on a timer.
	 *
	 * @returns {void}
	 */
	requestState: function () {
		this.sendWSCommand('RequestState')
	},

	/**
	 * Sends one form-encoded POST to BreakTime and returns what came back
	 *
	 * Never touches the status (the WebSocket owns it) and never throws: a timeout or
	 * network failure comes back as a result with `status` 0. Sends the API key when one
	 * is set. The timeout is REST_TIMEOUT_MS, below Companion's 5 s action IPC timeout.
	 * Returns null when the module was destroyed while the request ran, so callers drop it.
	 * The result carries the attempt generation at send time (`gen`), so a late answer can
	 * tell whether the connection it belonged to is still the current one.
	 *
	 * @async
	 * @param {string} path - Route path, e.g. `/api/playlist/next-event`
	 * @param {Object<string, boolean|number|string>} form - Form fields, encoded by `encodeForm()`
	 * @returns {Promise<RestResult|null>} The result, or null after `destroy()`
	 */
	sendREST: async function (path, form) {
		let self = this

		const gen = self.attemptGen

		const result = await self.restRequest('POST', path, form, self.apiKey, {
			host: self.config.host,
			port: self.config.port,
			apiKey: self.apiKey,
		})

		if (self.destroyed) {
			return null
		}

		result.gen = gen

		return result
	},

	/**
	 * Performs one HTTP request to BreakTime; the shared transport for `sendREST` and the pre-connect checks
	 *
	 * Always reads the body and parses it when it is JSON. Logs a `rest: request` debug
	 * trace (Verbose Logging only; skipped once destroyed). Never throws.
	 *
	 * @private
	 * @async
	 * @param {'GET'|'POST'} method - HTTP method
	 * @param {string} path - Route path
	 * @param {Object<string, boolean|number|string>|undefined} form - Form fields for a POST, or undefined
	 * @param {string} apiKey - API key to send, or '' to send none
	 * @param {AttemptTarget} target - Host and port to send to
	 * @returns {Promise<RestResult>} The result
	 */
	restRequest: async function (method, path, form, apiKey, target) {
		let self = this

		const started = Date.now()
		const headers = self.buildHeaders(apiKey)

		/** @type {RequestInit} */
		const options = {
			method: method,
			headers: headers,
			signal: AbortSignal.timeout(self.REST_TIMEOUT_MS),
		}

		if (form !== undefined) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded'
			options.body = self.encodeForm(form)
		}

		/** @type {RestResult} */
		let result

		try {
			const response = await fetch(`http://${target.host}:${target.port}${path}`, options)
			const text = await response.text()

			result = {
				status: response.status,
				body: parseBody(text),
				took: Date.now() - started,
				error: null,
				errorText: '',
			}
		} catch (error) {
			const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
			const code = error?.cause?.code

			// Only a system error code is safe to repeat: fetch error messages can carry
			// request data such as a rejected header value, which may be the API key.
			result = {
				status: 0,
				body: null,
				took: Date.now() - started,
				error: timedOut ? 'timeout' : 'network',
				errorText: typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : 'request error',
			}
		}

		if (!self.destroyed) {
			self.logEvent('debug', 'rest', 'request', {
				method: method,
				path: path,
				http: result.status || undefined,
				reason: result.error ? self.describeFailure(result) : undefined,
				took: self.formatDuration(result.took),
			})
		}

		return result
	},

	/**
	 * Encodes form fields per the BreakTime body format
	 *
	 * BreakTime binds form values with no 400 on a bad value, so the encoding matters:
	 * booleans become the literal `true` / `false` (`1` or `on` would silently bind false),
	 * numbers are written with `String()` and must be whole (a `delta` such as `5.0` binds
	 * 0), and GUID strings are passed through as given (the module only sends canonical IDs
	 * taken from state frames). Undefined and null fields are left out.
	 *
	 * @private
	 * @param {Object<string, boolean|number|string>} form - Form fields
	 * @returns {string} `application/x-www-form-urlencoded` body
	 */
	encodeForm: function (form) {
		const params = new URLSearchParams()

		for (const key in form) {
			const value = form[key]

			if (value !== undefined && value !== null) {
				params.append(key, String(value))
			}
		}

		return params.toString()
	},

	/**
	 * Applies the REST response-handling rules to one action response, logs the gesture's line and raises its warning
	 *
	 * Writes exactly one `action:` line (info when Accepted, warn otherwise) with the ack
	 * outcome verbatim, or `Timeout`, `NetworkError`, `HttpError` or `Unknown`, plus
	 * `firingId=`, `seq=` and `detail=` when the ack carries them. Warnings follow the
	 * response rules below: every refusal outcome raises an `ack` warning with BreakTime's
	 * detail, except `DuplicateActuation`, and `AlreadyInThatState` on End, which are
	 * log-only. A 401 also terminates the WebSocket so the next attempt re-derives
	 * AuthenticationFailure, but only when the request was sent on the current attempt: a
	 * late 401 from before a host or key change must not drop the new socket. When the
	 * response raised no warning and the spec carries a standby warning, the `ha` warning
	 * is raised instead (HA standby rule: Paired and not Acting). With `spec.deferWarning`
	 * the warning is returned in the report instead of raised. Never auto-retries and never
	 * sends RequestState: the caller decides from the returned report.
	 *
	 * @param {ActionSpec} spec - What was requested
	 * @param {RestResult|null} result - What `sendREST` returned; null after `destroy()`
	 * @returns {ActionReport} What the response meant
	 */
	reportActionResult: function (spec, result) {
		let self = this

		/** @type {ActionReport} */
		const report = {
			outcome: 'Unknown',
			accepted: false,
			unknown: false,
			ack: null,
			warning: null,
			logFields: null,
		}

		if (!result) {
			return report
		}

		const fields = { ...spec.fields }
		const ackRoute = spec.kind !== 'duration'

		let http
		let reason
		let detail
		let firingId
		let seq
		let warningType = null
		let warningText = ''

		if (result.error === 'timeout') {
			report.outcome = 'Timeout'

			if (ackRoute) {
				report.unknown = true
				warningType = 'ack'
				warningText = self.outcomeUnknownText(spec.kind)
			} else {
				warningType = 'connection'
				warningText = 'No answer from BreakTime, the duration may have changed'
			}
		} else if (result.error === 'network') {
			report.outcome = 'NetworkError'
			reason = `Cannot reach BreakTime (${result.errorText})`
			warningType = 'connection'
			warningText = reason
		} else if (result.status === 200 && !ackRoute) {
			if (result.body === true) {
				report.outcome = OUTCOME_ACCEPTED
			} else if (result.body === false) {
				report.outcome = 'EventNotFound'
				reason = 'Event is no longer in the playlist'
				warningType = spec.warningType
				warningText = reason
			} else {
				report.outcome = 'Unknown'
				reason = 'Unexpected response from BreakTime'
				warningType = 'connection'
				warningText = reason
			}
		} else if (result.status === 200 && isAck(result.body)) {
			const ack = result.body

			report.ack = ack
			report.outcome = ack.outcome
			firingId = ack.firingId
			seq = ack.actuationSeq

			if (spec.kind === 'startArmed') {
				// Name the event BreakTime actually fired, never the local arm
				fields.event = ack.eventId
					? self.DATA.events.find((event) => event.ID === ack.eventId)?.Name
					: undefined
				fields.id = ack.eventId ?? undefined
			}

			if (ack.outcome === OUTCOME_ACCEPTED) {
				detail = ack.emissionDetail

				if (!ack.emitted && ack.emissionDetail) {
					warningType = 'ack'
					warningText = `Nothing sent from this instance: ${ack.emissionDetail}`
				}
			} else {
				detail = ack.detail || undefined

				const logOnly =
					ack.outcome === 'DuplicateActuation' ||
					(ack.outcome === 'AlreadyInThatState' && spec.kind === 'end')

				if (!logOnly) {
					warningType = 'ack'
					warningText = ack.detail || ack.outcome
				}
			}
		} else if (result.status === 200) {
			report.outcome = 'Unknown'
			report.unknown = true
			warningType = 'ack'
			warningText = self.outcomeUnknownText(spec.kind)
		} else {
			http = result.status
			report.outcome = 'HttpError'

			if (http === 401) {
				reason = self.apiKey ? MSG_KEY_REJECTED : MSG_NEED_KEY
				warningType = 'auth'
				warningText = reason

				if (result.gen === self.attemptGen) {
					self.dropSocketForAuth()
				}
			} else if (http === 403) {
				reason = 'API key lacks permission for this action'
				warningType = 'auth'
				warningText = reason
			} else if (http === 404) {
				reason = 'This BreakTime version does not support this action'
				warningType = 'version'
				warningText = reason
			} else if (http === 409 && !ackRoute) {
				detail = result.body?.error
				warningType = spec.warningType
				warningText = result.body?.error || 'Event is running'
			} else if (http === 500 && ackRoute) {
				report.outcome = 'Unknown'
				report.unknown = true
				warningType = 'ack'
				warningText = self.outcomeUnknownText(spec.kind)
			} else {
				reason = `Request failed (HTTP ${http})`
				warningType = 'connection'
				warningText = reason
			}
		}

		report.accepted = report.outcome === OUTCOME_ACCEPTED

		if (!warningType && spec.standbyWarning) {
			warningType = 'ha'
			warningText = spec.standbyWarning
		}

		report.logFields = {
			outcome: report.outcome,
			http: http,
			reason: reason,
			firingId: firingId,
			seq: seq,
			detail: detail,
		}

		if (spec.beforeLog) {
			spec.beforeLog(report)
		}

		self.logEvent(report.accepted ? 'info' : 'warn', 'action', spec.verb, {
			...fields,
			...report.logFields,
			acting: spec.acting,
			took: self.formatDuration(result.took),
		})

		if (warningType && spec.deferWarning) {
			report.warning = { type: warningType, text: warningText }
		} else if (warningType) {
			self.issueWarning(warningType, warningText, self.WARNING_MS)
		}

		return report
	},

	/**
	 * Logs a gesture that sent nothing (`outcome=NotSent`) and raises its local-guard warning
	 *
	 * Local-guard warnings last WARNING_LOCAL_MS. Pass a null `warningType` for a guard that
	 * logs but shows nothing (Set Armed Duration "Already set").
	 *
	 * @param {string} verb - `action:` verb
	 * @param {Object<string, *>} fields - Leading log fields (target, event, id, ...)
	 * @param {string|null} warningType - Warning type for the `temporaryWarning` feedback, or null for none
	 * @param {string} reason - Module-authored reason, also the warning text
	 * @returns {void}
	 */
	reportNotSent: function (verb, fields, warningType, reason) {
		let self = this

		if (self.destroyed) {
			return
		}

		self.logEvent('warn', 'action', verb, { ...fields, outcome: 'NotSent', reason: reason })

		if (warningType) {
			self.issueWarning(warningType, reason, self.WARNING_LOCAL_MS)
		}
	},

	/**
	 * Returns the "outcome unknown" warning text for a route family
	 *
	 * @private
	 * @param {ActionSpec['kind']} kind - Route family
	 * @returns {string} Warning text
	 */
	outcomeUnknownText: function (kind) {
		if (kind === 'arm') {
			return 'Not confirmed by BreakTime, the arm may have changed'
		}

		if (kind === 'startArmed') {
			return 'Not confirmed by BreakTime, it may have started. Check what is running: pressing again starts the next event.'
		}

		return 'Not confirmed by BreakTime, it may have gone through. Check what is running before pressing again.'
	},

	/**
	 * Terminates the WebSocket after a REST 401, so the next attempt re-derives AuthenticationFailure
	 *
	 * BreakTime does not drop open sockets when security is enabled or a key is revoked, so
	 * the socket could otherwise keep delivering frames with an unusable key. The close
	 * handler logs the drop as `conn: lost`; the auth status itself comes from the next
	 * attempt's version check.
	 *
	 * @private
	 * @returns {void}
	 */
	dropSocketForAuth: function () {
		let self = this

		if (!self.WS) {
			return
		}

		if (!self.closeReason) {
			self.closeReason = MSG_ACTION_401
		}

		self.WS.terminate()
	},

	/**
	 * Converts milliseconds to whole seconds, `mm:ss` or `hh:mm:ss`
	 *
	 * A non-finite input (a field missing from the event, e.g. while disconnected) gives
	 * '', never `NaN:NaN`.
	 *
	 * @param {number|string} ms - Time in milliseconds
	 * @param {'ss'|'mm:ss'|'hh:mm:ss'} format - Output format
	 * @returns {number|string} Seconds as a number for `ss`, otherwise a zero-padded string; '' for a non-finite input
	 */
	convertTime: function (ms, format) {
		// Make sure it's a number
		ms = Number(ms)

		if (!Number.isFinite(ms)) {
			return ''
		}

		let seconds = Math.abs(Math.ceil(ms / 1000))
		let minutes = Math.abs(Math.floor(seconds / 60))
		let hours = Math.abs(Math.floor(minutes / 60))

		if (format === 'ss') {
			return seconds
		} else if (format === 'mm:ss') {
			return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
		} else if (format === 'hh:mm:ss') {
			return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
		} else {
			return ms // Unsupported format: the milliseconds unchanged
		}
	},
}
