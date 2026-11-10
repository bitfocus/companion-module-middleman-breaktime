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
 * or key change, through `startAttempt()` in main.ts) sets Connecting first; a
 * re-attempt (the re-attempt timer, or a config save while waiting on it) keeps the
 * current status. Either becomes Ok on the first state frame. Every failure schedules the
 * next attempt through `scheduleRetry()`.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

import { InstanceStatus } from '@companion-module/base'
import WebSocket from 'ws'

import type { CompanionOptionValues, JsonValue, LogLevel } from '@companion-module/base'
import type BreakTimeInstance from './main.js'

import {
	DURATION_MIN_S,
	DURATION_MAX_SPLICE_S,
	DURATION_MAX_TIME_SIGNAL_S,
	DURATION_STEP_MAX_S,
	PENDING_DURATION_MS,
	PRESS_DEBOUNCE_MS,
	MODULE_VERSION,
} from './defaults.js'

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
 * Only `ID` is always present: while the WebSocket is down the module keeps only `ID` and
 * `Name` of each event (see `handleDisconnect()`), and `resolveChosenEvent()` builds a
 * bare `{ ID }` for an event BreakTime must resolve itself. Every other field may be
 * undefined. BreakTime sends more fields (SCTE options, `ActuationFiringId`, ...) that the
 * module does not read.
 */
export interface BreakTimeEvent {
	/** Event ID: lowercase hyphenated GUID */
	ID: string
	/** Event name */
	Name?: string
	/** Event description */
	Description?: string
	/** 0 Count Down, 1 Count Up */
	DurationMode?: 0 | 1
	/** Duration in seconds; 6 s floor, ceilings 6553 s (Splice Insert) / 65535 s (Time Signal) */
	DurationSeconds?: number
	/** 0 Splice Insert, 1 Time Signal */
	MessageMode?: 0 | 1
	/** 0 Stopped, 1 Running */
	Status?: 0 | 1
	/** Whole seconds since the start, recomputed each tick */
	ElapsedSeconds?: number
	/**
	 * Whole seconds left; meaningful only for Count Down (for Count Up it is `DurationSeconds - ElapsedSeconds`
	 * and can go negative)
	 */
	RemainingSeconds?: number
	/** BreakTime's per-node stopwatch at the start; orders running events */
	StartMS?: number
	/** Start time as BreakTime formats it */
	StartTime?: string | null
	/** SCTE splice event ID of the last actuation (Splice Insert); 0 for none */
	ActuationSpliceEventID?: number
	/** SCTE segmentation event ID of the last actuation (Time Signal); 0 for none */
	ActuationSegmentationEventID?: number
}

/** BreakTime's HA block in a state frame; its enum values are JSON strings holding the name */
export interface HaState {
	/** `Undefined` on an unlicensed node */
	Role: 'Undefined' | 'Primary' | 'Secondary'
	/** True while paired with a partner */
	Paired: boolean
	/** Mirrors write authority; not on its own "this node will emit" */
	Acting: boolean
	/** True on a promoted Secondary */
	Promoted: boolean
	/** True when this node is ready to emit */
	EmitReady: boolean
	/** Peer link state; `Inactive` is standalone, not a fault */
	LinkState: 'Inactive' | 'Connecting' | 'Connected' | 'Degraded'
	/** Partner role, or null while the link is not connected */
	PeerRole: string | null
	/** Link detail text */
	LinkDetail: string
	/** Emit output detail text */
	EmitOutputDetail: string
	/** This node's instance ID */
	InstanceID: string
}

/**
 * One state frame from `/api/ws` (JSON text, PascalCase, about 1 per second plus extra frames on changes)
 *
 * Null keys are written as `null`. Event and component enums are integers; the `HA`
 * enums are strings. `HA` is always present in BreakTime 2.0 and absent in 1.x, which is
 * how the first frame tells them apart. Only the keys listed here are read; BreakTime
 * sends many more. Fields are typed optional to match the module's defensive reads of a
 * frame that may be malformed.
 */
export interface StateFrame {
	/** The playlist, in playlist order */
	Playlist?: { Events?: BreakTimeEvent[] }
	/**
	 * The armed event, or null; a live pointer BreakTime does not check against the playlist (it can name a
	 * deleted event)
	 */
	NextEvent?: BreakTimeEvent | null
	/** The last event started locally since BreakTime started, or null; never cleared, so it may be stale */
	LastStartedEvent?: BreakTimeEvent | null
	/** Component status by key (`Status`: 0 Disabled, 1 Unhealthy, 2 Warning, 3 Healthy) */
	ComponentStatuses?: Record<string, { Status: 0 | 1 | 2 | 3; StatusDetail: string }>
	/** HA state */
	HA?: HaState | null
	/** HA role alarm text, or null */
	HARoleAlarm?: string | null
	/** One-shot warning text, cleared by BreakTime after each broadcast */
	GlobalWarning?: string | null
}

/**
 * Ack BreakTime returns (HTTP 200) for start, start-armed, end and next-event, in camelCase
 *
 * Success is keyed on `outcome`, never on `eventId` being present (`EventNotFound` echoes
 * the requested ID). `detail` is prose and is never branched on.
 */
export interface FireAck {
	/** `outcome === 'Accepted'` */
	acted: boolean
	/** True when a message was sent to at least one output */
	emitted: boolean
	/** Decided outcome */
	outcome:
		| 'Accepted'
		| 'NotLicensed'
		| 'UnpairedSecondary'
		| 'RecoveringState'
		| 'EventNotFound'
		| 'AlreadyInThatState'
		| 'PlaylistReplaced'
		| 'DuplicateActuation'
		| 'NothingArmed'
	/** Human-readable explanation */
	detail: string
	/** Non-null on every `emitted:true` ack: `sent to X`, or `sent to X; <refusal>` for a partial send */
	emissionDetail: string | null
	/** Lowercase hyphenated GUID of the event acted on; null for `NothingArmed` */
	eventId: string | null
	/** GUID matching BreakTime's history; null on every refusal and on an accepted arm */
	firingId: string | null
	/** Actuation sequence number; null on every refusal and on an accepted arm */
	actuationSeq: number | null
}

/** Result of one REST request; `sendREST` returns it to the action handlers */
export interface RestResult {
	/** HTTP status code, 0 when no response arrived */
	status: number
	/** Parsed JSON body, the raw text when it is not JSON, or null when empty */
	body: unknown
	/** Milliseconds from request start to the end of the body */
	took: number
	/** Why no response arrived, or null when one did */
	error: 'timeout' | 'network' | null
	/** System error code, or `request error` when there is none; '' when a response arrived */
	errorText: string
	/** Attempt generation when the request was sent (`sendREST` only), so a late 401 cannot drop a newer socket */
	gen?: number
}

/** A Set Armed Duration target BreakTime accepted but no state frame shows yet */
export interface PendingDuration {
	/** Event ID */
	id: string
	/** Duration BreakTime now holds for that event */
	seconds: number
	/** Time (ms since epoch) after which the value is no longer trusted */
	until: number
}

/** Connection target captured at the start of an attempt, so a config change mid-attempt cannot redirect it */
export interface AttemptTarget {
	/** Normalized host */
	host: string
	/** Normalized port */
	port: string
	/** Normalized API key, '' when none is set */
	apiKey: string
}

/** Log fields: key/value pairs from the fixed key vocabulary, in output order */
export type LogFields = Record<string, unknown>

/** Route family of an action gesture; selects the response rules */
export type ActionKind = 'start' | 'startArmed' | 'end' | 'arm' | 'duration'

/** One action gesture's request description, passed to `reportActionResult` */
export interface ActionSpec {
	/** `action:` verb of the module's log convention (`<area>: <verb> key=value`), e.g. `start` or `arm next` */
	verb: string
	/** Route family; selects the response rules */
	kind: ActionKind
	/** Leading log fields (target, event, id, delta, to), in output order */
	fields: LogFields
	/** Warning type for duration refusals (`increaseDuration` / `decreaseDuration`) */
	warningType?: string
	/** HA acting flag, logged as `acting=` when set (standby gestures, see `getStandbyWarning`) */
	acting?: boolean
	/** `ha` warning text raised when the response raised no warning of its own */
	standbyWarning?: string
	/** When true the warning is returned in the report instead of raised (End `all` combines them) */
	deferWarning?: boolean
	/**
	 * The action callback's abort signal; when it has aborted, the post-send warning is suppressed (and not
	 * deferred), because the operator cancelled the running actions. The line is still logged.
	 */
	signal?: AbortSignal
	/**
	 * Called with the report just before the gesture's line is written (arm presses folded into this request log
	 * there, so lines follow press order)
	 */
	beforeLog?: (report: ActionReport) => void
}

/** A timed warning to raise */
export interface WarningSpec {
	/** Warning type ID from CHOICES_WARNINGS */
	type: string
	/** Warning text */
	text: string
}

/** The outcome keys of a logged action line, read by `logFoldedArm()` */
export interface ActionLogFields {
	outcome: string
	http: number | undefined
	reason: string | undefined
	firingId: string | null | undefined
	seq: number | null | undefined
	detail: string | null | undefined
}

/** What one action response meant, returned by `reportActionResult` */
export interface ActionReport {
	/** Ack outcome verbatim, or `Timeout`, `NetworkError`, `HttpError` or `Unknown` */
	outcome: string
	/** True when the outcome is `Accepted` */
	accepted: boolean
	/** True when the request may have been applied but no answer says so (timeout, or 500 on an ack route) */
	unknown: boolean
	/** The parsed ack, when the response carried one */
	ack: FireAck | null
	/** The warning this response called for; only filled when the spec set `deferWarning` */
	warning: WarningSpec | null
	/** Outcome keys of the logged line, in output order, read by `logFoldedArm()`; null when nothing was logged */
	logFields: ActionLogFields | null
}

/** One Arm Next, Arm Previous or Arm Event press waiting for, or leading, an arm request */
export interface ArmPress {
	/** `action:` verb (`arm`, `arm next` or `arm previous`) */
	verb: string
	/** The press's own target */
	event: { ID: string; Name?: string }
	/** `ha` warning text when sent to a standby node, '' otherwise */
	standbyWarning: string
	/** Time of the press (ms since epoch), for `took=` */
	started: number
}

/** The arm request in flight and the presses made while it runs */
export interface ArmFlight {
	/** Presses made while the request runs, in press order; the last one's target is sent next */
	waiting: ArmPress[]
	/**
	 * True once a host or port change dropped the waiting presses: the request in flight went to the previous
	 * server, so no later press may fold into it
	 */
	dropped: boolean
}

/**
 * Returns the major version number of a BreakTime version string, or null when it has none
 *
 * Example: `2.0.222-beta+e8d7026389` gives 2; `unknown` gives null.
 *
 * @param version - Version string from `GET /api/version`
 * @returns Major version, or null when unparsable
 */
function parseMajorVersion(version: string): number | null {
	const match = /^(\d+)(?:[.+-]|$)/.exec(version)

	return match ? Number(match[1]) : null
}

/**
 * Parses a response body as JSON, falling back to the raw text
 *
 * @param text - Response body text
 * @returns Parsed value, the text itself when it is not JSON, or null when empty
 */
function parseBody(text: string): unknown {
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
 * @param body - Parsed response body
 * @returns True for an object with a string `outcome`
 */
function isAck(body: unknown): body is FireAck {
	return body !== null && typeof body === 'object' && typeof (body as { outcome?: unknown }).outcome === 'string'
}

/**
 * Returns true when a parsed state frame is a JSON object (not null, an array or a scalar)
 *
 * @param data - Parsed frame
 * @returns True for a plain JSON object
 */
function isFrameObject(data: unknown): data is StateFrame {
	return data !== null && typeof data === 'object' && !Array.isArray(data)
}

/**
 * Returns the message of a thrown value, preferring its own `message` string
 *
 * @param error - The thrown value
 * @returns `error.message` when it is a string, otherwise `String(error)`
 */
function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}

	if (typeof error === 'object' && error !== null) {
		const message = (error as { message?: unknown }).message

		if (typeof message === 'string') {
			return message
		}
	}

	return String(error)
}

/**
 * Sort comparator for running events: newest first by `StartMS`
 *
 * `StartMS` is BreakTime's per-node stopwatch. `Array.prototype.sort` is stable, so
 * events with the same `StartMS` keep their playlist order.
 *
 * @param a - Running event
 * @param b - Running event
 * @returns Negative when `a` started later than `b`
 */
function compareStartDescending(a: BreakTimeEvent, b: BreakTimeEvent): number {
	return (Number(b.StartMS) || 0) - (Number(a.StartMS) || 0)
}

/**
 * Sort comparator for running events that have no slot yet: oldest first by `StartMS`
 *
 * Stable, so events with the same `StartMS` keep their input order. `DATA.running`
 * lists ties in playlist order, so ties go to the earlier playlist entry first.
 *
 * @param a - Running event
 * @param b - Running event
 * @returns Negative when `a` started earlier than `b`
 */
function compareStartAscending(a: BreakTimeEvent, b: BreakTimeEvent): number {
	return (Number(a.StartMS) || 0) - (Number(b.StartMS) || 0)
}

/**
 * Clamps a duration to the range BreakTime enforces for an event's message mode
 *
 * @param seconds - Duration in seconds
 * @param messageMode - `MessageMode`: 0 Splice Insert, 1 Time Signal
 * @returns Duration clamped to 6..6553 (Splice Insert) or 6..65535 (Time Signal)
 */
function clampDuration(seconds: number, messageMode: number | undefined): number {
	const max = messageMode === 1 ? DURATION_MAX_TIME_SIGNAL_S : DURATION_MAX_SPLICE_S

	return Math.min(Math.max(seconds, DURATION_MIN_S), max)
}

/**
 * Returns true for the two component statuses whose changes between each other are logged at debug only
 *
 * @param status - Component status name
 * @returns True for Healthy or Warning
 */
function isHealthyOrWarning(status: string | undefined): boolean {
	return status === 'Healthy' || status === 'Warning'
}

export const api = {
	/**
	 * Starts a fresh, config-driven connection attempt
	 *
	 * Called by main.ts after init or a host, port or key change. Resets the lost streak
	 * (so the next success logs `conn: connected`, not `restored`) and the connection log
	 * latches, so the new target's first failure is logged.
	 *
	 * @returns void
	 */
	initConnection(): void {
		const self: BreakTimeInstance = this

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
	 * generation and the target. The attempt promise always ends in `.catch`: an unhandled
	 * rejection ends the process, and base installs no handler. Called by
	 * `initConnection()`, by the re-attempt timer, and by `configUpdated` while waiting on
	 * that timer. Never sets Connecting itself, so a re-attempt keeps the current status
	 * until its outcome differs.
	 *
	 * @returns void
	 */
	startConnectAttempt(): void {
		const self: BreakTimeInstance = this

		self.closeConnection()

		if (self.destroyed) {
			return
		}

		const gen = ++self.attemptGen

		const target: AttemptTarget = { host: self.config.host, port: self.config.port, apiKey: self.apiKey }

		self.handshakeOutcome = null

		if (self.lostAt !== null) {
			self.attempts++
		}

		self.connectAttempt(gen, target).catch((error) => {
			if (self.destroyed || gen !== self.attemptGen) {
				return
			}

			self.closeConnection()
			self.reportConnectionFailure(target, `Connection attempt failed: ${errorMessage(error)}`)
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
	 * @param gen - Attempt generation captured by `startConnectAttempt()`
	 * @param target - Host, port and key captured at attempt start
	 * @returns Resolves when the attempt has opened a socket or scheduled a retry
	 */
	async connectAttempt(gen: number, target: AttemptTarget): Promise<void> {
		const self: BreakTimeInstance = this

		const isStale = (): boolean => self.destroyed || gen !== self.attemptGen

		// Check 1: security
		const whoami = await self.restRequest('GET', '/api/whoami', undefined, '', target)

		if (isStale()) {
			return
		}

		/** Reason to log for a failed whoami once BreakTime proves reachable; null when whoami was usable */
		let whoamiFailure: string | null = null

		const whoamiBody = whoami.body as { authEnabled?: unknown } | null

		if (whoami.status === 200 && typeof whoamiBody?.authEnabled === 'boolean') {
			self.logLatches.delete('rest:/api/whoami')
			self.setBreakTimeInfo('breaktimeSecurity', whoamiBody.authEnabled ? 'On' : 'Off')

			if (whoamiBody.authEnabled && !target.apiKey) {
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
			const versionBody = version.body as { version?: unknown } | null
			const raw = typeof versionBody?.version === 'string' ? versionBody.version : ''
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
	 * @param target - Host, port and key captured at attempt start
	 * @returns void
	 */
	openSocket(target: AttemptTarget): void {
		const self: BreakTimeInstance = this

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
	 * @param target - Attempt target
	 * @param code - HTTP status code of the handshake response
	 * @returns void
	 */
	handleHandshakeResponse(target: AttemptTarget, code: number | undefined): void {
		const self: BreakTimeInstance = this

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
	 * @param target - Attempt target
	 * @param data - Parsed frame
	 * @returns True when the frame was accepted and should be applied
	 */
	handleFirstFrame(target: AttemptTarget, data: unknown): boolean {
		const self: BreakTimeInstance = this

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

		const fields: LogFields = {
			host: `${target.host}:${target.port}`,
			status: InstanceStatus.Ok,
			attempts: restored ? self.attempts : undefined,
			down: restored && self.lostAt !== null ? self.formatDuration(Date.now() - self.lostAt) : undefined,
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
	 * @param raw - Raw frame payload
	 * @returns The parsed frame, or undefined when it is not valid JSON
	 */
	parseFrame(raw: WebSocket.RawData): unknown {
		const self: BreakTimeInstance = this

		// ws delivers one of Buffer | ArrayBuffer | Buffer[]; decode each to the frame's utf8 text
		const text = Buffer.isBuffer(raw)
			? raw.toString('utf8')
			: Array.isArray(raw)
				? Buffer.concat(raw).toString('utf8')
				: Buffer.from(raw).toString('utf8')

		if (self.config.verboseWebsocket && self.config.verbose) {
			self.log('debug', `state: frame dump ${text}`)
		}

		try {
			return JSON.parse(text)
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
	 * @param error - What was thrown
	 * @returns void
	 */
	logFrameError(error: unknown): void {
		const self: BreakTimeInstance = this

		if (self.logLatches.has(LATCH_FRAME_ERROR)) {
			return
		}

		self.logLatches.add(LATCH_FRAME_ERROR)
		self.logEvent('error', 'state', 'frame error', { reason: errorMessage(error) })
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
	 * @returns void
	 */
	refreshState(): void {
		const self: BreakTimeInstance = this

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
	 * @param key - DATA field
	 * @param value - New value
	 * @returns void
	 */
	setBreakTimeInfo(key: 'breaktimeSecurity' | 'breaktimeVersion', value: string): void {
		const self: BreakTimeInstance = this

		if (self.DATA[key] === value) {
			return
		}

		if (key === 'breaktimeSecurity') {
			self.DATA.breaktimeSecurity = value as '' | 'On' | 'Off'
		} else {
			self.DATA.breaktimeVersion = value
		}

		self.refreshState()
	},

	/**
	 * Returns true while a live socket has delivered its first frame (status Ok), so the cached state can be trusted
	 *
	 * @returns True when the armed and running state reflect BreakTime
	 */
	isLive(): boolean {
		const self: BreakTimeInstance = this

		return self.WS !== null && self.lastStatus === InstanceStatus.Ok
	},

	/**
	 * Hook: resets frame-derived state when the WebSocket drops after delivering frames
	 *
	 * Called by the close handler for a socket that reached Ok, and by main.ts before a
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
	 * `setVariableValues()` with one `checkAllFeedbacks()`, and the first frame after
	 * reconnect counts as fully changed.
	 *
	 * @returns void
	 */
	handleDisconnect(): void {
		const self: BreakTimeInstance = this

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
	 * @param ms - Delay before the next attempt
	 * @returns void
	 */
	scheduleRetry(ms: number): void {
		const self: BreakTimeInstance = this

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
	 * @param ws - The socket being watched
	 * @returns void
	 */
	armWatchdog(ws: WebSocket): void {
		const self: BreakTimeInstance = this

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
	 * @param target - Attempt target
	 * @param reason - Status message, also the logged `reason`
	 * @param http - HTTP status code, when the failure was an HTTP response
	 * @returns void
	 */
	reportConnectionFailure(target: AttemptTarget, reason: string, http?: number): void {
		const self: BreakTimeInstance = this

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
	 * @param target - Attempt target
	 * @param reason - Status message, also the logged `reason`
	 * @param http - HTTP status code, when BreakTime answered 401
	 * @returns void
	 */
	reportAuthFailure(target: AttemptTarget, reason: string, http?: number): void {
		const self: BreakTimeInstance = this

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
	 * @param target - Attempt target
	 * @param reason - Status message, also the logged `reason`
	 * @param http - HTTP status code, when a handshake response gave it away
	 * @returns void
	 */
	reportUnsupported(target: AttemptTarget, reason: string, http?: number): void {
		const self: BreakTimeInstance = this

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
	 * @param target - Attempt target
	 * @param version - Version string BreakTime returned, or ''
	 * @returns Status message
	 */
	buildUnsupportedMessage(target: AttemptTarget, version: string): string {
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
	 * @param level - Log level
	 * @param verb - `conn:` verb
	 * @param fields - Log fields
	 * @returns True when the line was written
	 */
	logConn(level: LogLevel, verb: string, fields: LogFields): boolean {
		const self: BreakTimeInstance = this

		const latch = verb === 'lost' ? 'conn:lost' : `conn:${verb}:${String(fields.reason)}`

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
	 * @param target - Attempt target
	 * @param method - HTTP method
	 * @param path - Request path
	 * @param result - The failed result
	 * @param reason - Module-authored reason; derived from the result when omitted
	 * @returns void
	 */
	logRestFailure(target: AttemptTarget, method: string, path: string, result: RestResult, reason?: string): void {
		const self: BreakTimeInstance = this

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
	 * @param prefix - Latch name prefix, e.g. `conn:`
	 * @returns void
	 */
	clearLogLatches(prefix: string): void {
		const self: BreakTimeInstance = this

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
	 * @param result - The failed result
	 * @returns e.g. `BreakTime did not respond`, `Cannot reach BreakTime (ECONNREFUSED)` or
	 *   `Unexpected response from BreakTime (HTTP 503)`
	 */
	describeFailure(result: RestResult): string {
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
	 * @param error - Socket error
	 * @returns e.g. `Cannot reach BreakTime (ECONNREFUSED)` or `Connection to BreakTime timed out`
	 */
	describeSocketError(error: Error & { code?: string }): string {
		if (error.code) {
			return `Cannot reach BreakTime (${error.code})`
		}

		if (/handshake has timed out/i.test(error.message ?? '')) {
			return 'Connection to BreakTime timed out'
		}

		return error.message ? `Connection error: ${error.message}` : 'Connection error'
	},

	/**
	 * Formats a duration for a log value: `<n>ms` below one second, otherwise whole seconds `<n>s`
	 *
	 * @param ms - Duration in milliseconds
	 * @returns Formatted duration
	 */
	formatDuration(ms: number): string {
		return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : `${Math.round(ms / 1000)}s`
	},

	/**
	 * Builds the request headers shared by REST requests and the WebSocket handshake
	 *
	 * @param apiKey - API key to send, or '' to send none
	 * @returns Headers
	 */
	buildHeaders(apiKey: string): Record<string, string> {
		const headers: Record<string, string> = { 'User-Agent': USER_AGENT }

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
	 * The normalized shape, with the rule for each field, is `BreakTimeData` in defaults.ts.
	 * A frame that is valid JSON but not an object is a frame error, and the whole body is
	 * wrapped so a throw cannot escape the WebSocket message handler and end the module
	 * process.
	 *
	 * @param data - Parsed state frame (PascalCase keys)
	 * @returns void
	 */
	processData(data: unknown): void {
		const self: BreakTimeInstance = this

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

			let armed: BreakTimeEvent | undefined = undefined
			const running: BreakTimeEvent[] = []

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

			let scte104Status: BreakTimeInstance['DATA']['scte104Status'] = 'Disconnected'

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
	 *    `StartMS` (ties in playlist order).
	 *
	 * While the run state is unknown (WebSocket down) every slot reads empty and only step
	 * 2's count rule is applied. Also called by `handleDisconnect()` and, from the last
	 * frame, when the slot count changes. Allocates only when a running event has no slot and
	 * a slot is free.
	 *
	 * @returns void
	 */
	assignRunningSlots(): void {
		const self: BreakTimeInstance = this

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
	 * nothing changes. A component whose key is missing reads Unknown. The log baseline
	 * (`componentsSeen`) survives a disconnect, so a reconnect logs only real changes; on
	 * the first frame for a host only an Unhealthy component is logged. Levels: warn for a
	 * change to Unhealthy, debug for Healthy to Warning and back, info otherwise.
	 *
	 * @param statuses - The frame's `ComponentStatuses`
	 * @returns void
	 */
	updateComponents(statuses: Record<string, { Status: number; StatusDetail: string }> | undefined): void {
		const self: BreakTimeInstance = this

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

			let level: LogLevel = 'info'

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
	 * Degraded or an alarm is set. Level warn for a change to Degraded or when a new non-null
	 * role alarm appears, info otherwise (including the alarm clearing).
	 *
	 * @param ha - The frame's `HA` object
	 * @param alarm - The frame's `HARoleAlarm`, null when none
	 * @returns void
	 */
	trackHa(ha: HaState | null, alarm: string | null): void {
		const self: BreakTimeInstance = this

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

		if (seen === null) {
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
	 * rebuilds the choices from real data. A missing or null name compares as '', the form
	 * `rebuildEventChoices()` stores, so an unnamed event does not read as changed on every frame.
	 *
	 * @param events - Playlist events from the current frame
	 * @returns True when the choices must be rebuilt
	 */
	isEventListChanged(events: BreakTimeEvent[]): boolean {
		const self: BreakTimeInstance = this
		const keys = self.eventListKeys

		if (keys === null || keys.length !== events.length * 2) {
			return true
		}

		for (let index = 0; index < events.length; index++) {
			if (keys[index * 2] !== events[index].ID || keys[index * 2 + 1] !== (events[index].Name ?? '')) {
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
	 * still shows. Every tile is then re-checked once (`checkFeedbacks('eventTile')`), which
	 * is what turns a pruned tile to "(removed)".
	 *
	 * @param events - Playlist events from the current frame
	 * @returns void
	 */
	rebuildEventChoices(events: BreakTimeEvent[]): void {
		const self: BreakTimeInstance = this

		const keys: string[] = []
		const choices: Array<{ id: string; label: string }> = []
		const listed = new Set<string>()

		for (const event of events) {
			keys.push(event.ID, event.Name ?? '')
			choices.push({ id: event.ID, label: event.Name || event.ID })
			listed.add(event.ID)
			self.DATA.eventNames.set(event.ID, event.Name ?? '')
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
	 * @param id - Option value
	 * @returns The event (possibly only `{ID}`), or null with the local-guard reason
	 */
	resolveChosenEvent(id: unknown): { event: BreakTimeEvent | null; reason: string } {
		const self: BreakTimeInstance = this

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
	 * @param kind - Gesture family
	 * @returns Warning text, or ''
	 */
	getStandbyWarning(kind: 'arm' | 'duration'): string {
		const self: BreakTimeInstance = this
		const ha = self.DATA.ha

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
	 * @returns Local-guard reason, or ''
	 */
	getDurationBlock(): string {
		const self: BreakTimeInstance = this

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
	 * @param eventId - Event ID
	 * @returns Seconds BreakTime accepted but no frame shows yet, or null
	 */
	getPendingDuration(eventId: string): number | null {
		const self: BreakTimeInstance = this

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
	 * armed-duration readouts follow a press at once instead of on the next frame.
	 *
	 * @returns Duration in seconds, or undefined when nothing is armed
	 */
	getArmedDuration(): number | undefined {
		const self: BreakTimeInstance = this

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
	 * last start press for the same target that sent a request (checked first; the target is
	 * the armed default, a window shared with Start Armed Event, or the chosen event's ID, so a
	 * start press for a different target is not blocked); with the armed default, refused
	 * while not connected (the cached arm may be stale) or when nothing is armed; a chosen
	 * event that is not in the playlist; an event that is already running; and with
	 * `onlyWhenIdle`, any running event (or running state unknown). A chosen event stays
	 * allowed while not connected. Sends RequestState after an accepted start and after an
	 * unknown outcome.
	 *
	 * @param options - Action options; undefined values take their defaults
	 * @param signal - Abort signal from the action callback; cancels the in-flight request and skips the cancelled-action warning
	 * @returns Resolves when BreakTime answered or the request was not sent
	 */
	async startSelected(options?: CompanionOptionValues, signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this

		const choice = options?.event ?? self.CHOICE_ARMED_EVENT.id
		const immediate = !!options?.immediate
		const onlyWhenIdle = !!options?.onlyWhenIdle
		const pressKey = `start:${typeof choice === 'string' ? choice : JSON.stringify(choice)}`

		if (self.isPressDebounced(pressKey)) {
			self.reportPressDebounced('start', {})
			return
		}

		let event: BreakTimeEvent | undefined

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

		const fields: LogFields = { event: event.Name, id: event.ID }

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

		self.markPressSent(pressKey)

		const result = await self.sendREST(
			`/api/playlist/events/${encodeURIComponent(event.ID)}/start`,
			{ immediate: immediate },
			signal,
		)

		const report = self.reportActionResult({ verb: 'start', kind: 'start', fields: fields, signal: signal }, result)

		if (report.accepted || report.unknown) {
			self.requestState()
		}
	},

	/**
	 * Start Armed Event: starts whatever BreakTime itself has armed (`POST /api/playlist/start`)
	 *
	 * Stays allowed while not connected: BreakTime reads its own arm. The log line names the
	 * event from `ack.eventId` (and that ID's name in the latest frame), never the local
	 * arm. Its only local guard is the start press debounce for the armed target: the window is
	 * shared with a Start Event left on the armed default, not with a Start Event for a chosen
	 * event. Sends RequestState after an accepted start and after an unknown outcome.
	 *
	 * @param options - Action options; undefined values take their defaults
	 * @param signal - Abort signal from the action callback; cancels the in-flight request and skips the cancelled-action warning
	 * @returns Resolves when BreakTime answered or the request was not sent
	 */
	async startArmed(options?: CompanionOptionValues, signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this

		// Share the armed debounce key with a Start Event action that targets the armed event, so a
		// genuine double-tap across the two action types is still debounced
		const pressKey = `start:${self.CHOICE_ARMED_EVENT.id}`

		if (self.isPressDebounced(pressKey)) {
			self.reportPressDebounced('start armed', {})
			return
		}

		self.markPressSent(pressKey)

		const result = await self.sendREST('/api/playlist/start', { immediate: !!options?.immediate }, signal)

		const report = self.reportActionResult(
			{ verb: 'start armed', kind: 'startArmed', fields: {}, signal: signal },
			result,
		)

		if (report.accepted || report.unknown) {
			self.requestState()
		}
	},

	/**
	 * End Running Event: ends the latest running event, all of them, or a chosen one
	 *
	 * A repeat of the SAME end target within PRESS_DEBOUNCE_MS of the end press that sent a
	 * request is refused first; a later end press for a DIFFERENT target (`latest`, `all` or a
	 * specific event) is not blocked. `latest` and `all` read the running events from the last
	 * frame, so they are refused locally while not connected; `specific` stays allowed then.
	 * Nothing running, or a `specific` event that is not running, is refused locally with an
	 * `event` warning. `all` posts every end concurrently, logs one line per event and
	 * raises one combined warning. RequestState is sent at most once.
	 *
	 * @param options - Action options; undefined values take their defaults
	 * @param signal - Abort signal from the action callback; cancels the in-flight requests and skips the cancelled-action warning
	 * @returns Resolves when every end answered or the request was not sent
	 */
	async endSelected(options?: CompanionOptionValues, signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this

		const rawTarget = options?.target
		const target = rawTarget === 'all' || rawTarget === 'specific' ? rawTarget : 'latest'
		const immediate = !!options?.immediate
		const pressKey =
			target === 'specific'
				? `end:specific:${typeof options?.event === 'string' ? options.event : JSON.stringify(options?.event)}`
				: `end:${target}`

		if (self.isPressDebounced(pressKey)) {
			self.reportPressDebounced('end', { target: target })
			return
		}

		let targets: BreakTimeEvent[]

		if (target === 'specific') {
			const resolved = self.resolveChosenEvent(options?.event)

			if (!resolved.event) {
				const id = resolved.reason === MSG_NOT_IN_PLAYLIST ? options?.event : undefined

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

		self.markPressSent(pressKey)

		const settled = await Promise.allSettled(
			targets.map(async (event) =>
				self.sendREST(
					`/api/playlist/events/${encodeURIComponent(event.ID)}/end`,
					{ immediate: immediate },
					signal,
				),
			),
		)

		const warnings: WarningSpec[] = []
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
					signal: signal,
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
	 * Returns true when a Start (or End) press falls within PRESS_DEBOUNCE_MS of the last press to the same
	 * target that sent a request
	 *
	 * Hot path of every Start and End press: one map lookup and a compare. The clock is
	 * monotonic (`performance.now()`), so a wall-clock step cannot hold the window open. Keying by
	 * target means two differently-targeted Start (or End) actions on one button each debounce
	 * independently, while a genuine repeat of the same target is still ignored.
	 *
	 * @param key - Press-target key, e.g. `start:armed`, `start:<eventId>`, `end:latest`, `end:specific:<eventId>`
	 * @returns True when the press must be ignored
	 */
	isPressDebounced(key: string): boolean {
		const self: BreakTimeInstance = this
		const sentAt = self.pressSentAt.get(key)

		return sentAt !== undefined && performance.now() - sentAt < PRESS_DEBOUNCE_MS
	},

	/**
	 * Opens the press debounce window for a target: call just before a Start (or End) press sends its request
	 *
	 * @param key - Press-target key (see `isPressDebounced`)
	 * @returns void
	 */
	markPressSent(key: string): void {
		const self: BreakTimeInstance = this
		self.pressSentAt.set(key, performance.now())
	},

	/**
	 * Logs an ignored Start (or End) press, raising the `event` warning only when no other warning is showing
	 *
	 * Always writes the one `outcome=NotSent` action line. The warning slot holds one
	 * warning and the newest wins, so a double-tap would otherwise replace the first press's
	 * answer. An active warning of any other type is therefore kept for its full time; an
	 * active `event` warning is replaced as usual.
	 *
	 * @param verb - `action:` verb (`start`, `start armed` or `end`)
	 * @param fields - Leading log fields
	 * @returns void
	 */
	reportPressDebounced(verb: string, fields: LogFields): void {
		const self: BreakTimeInstance = this

		const keep = self.DATA.temporaryWarning && self.DATA.temporaryWarningType !== 'event'

		self.reportNotSent(verb, fields, keep ? null : 'event', MSG_PRESSED_AGAIN)
	},

	/**
	 * Closes every press debounce window, so the next Start or End press acts at once
	 *
	 * Called when the connection is lost and when the host or port changes: a press made
	 * then belongs to a new connection, not to the press before it.
	 *
	 * @returns void
	 */
	releasePressWindows(): void {
		const self: BreakTimeInstance = this
		self.pressSentAt.clear()
	},

	/**
	 * Arm Next: arms the event after the armed one, wrapping from the last to the first
	 *
	 * @param signal - Abort signal from the action callback; cancels this press's own arm request and skips the cancelled-action warning
	 * @returns Resolves when this press's own request answered, or at once for a folded press
	 */
	async selectNextEvent(signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this
		await self.stepArm(1, signal)
	},

	/**
	 * Arm Previous: arms the event before the armed one, wrapping from the first to the last
	 *
	 * @param signal - Abort signal from the action callback; cancels this press's own arm request and skips the cancelled-action warning
	 * @returns Resolves when this press's own request answered, or at once for a folded press
	 */
	async selectPreviousEvent(signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this
		await self.stepArm(-1, signal)
	},

	/**
	 * Arms the playlist neighbor of the armed event, wrapping at both ends
	 *
	 * Rapid presses step from the pending-arm target (the latest target of the arm request
	 * in flight, see `armEvent()`) when one is set, otherwise from the frame's armed ID, so
	 * three quick presses end three events on, without a blocking promise chain. When the
	 * armed event is unknown, Next arms the first event and Previous the last. An empty
	 * playlist sends nothing.
	 *
	 * @param direction - 1 for Next, -1 for Previous
	 * @param signal - Abort signal from the action callback; cancels this press's own arm request and skips the cancelled-action warning
	 * @returns Resolves when this press's own request answered, or at once for a folded press
	 */
	async stepArm(direction: 1 | -1, signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this

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

		await self.armEvent(verb, events[nextIndex], signal)
	},

	/**
	 * Arm Event: arms the event chosen in the action's `event` option
	 *
	 * @param options - Action options
	 * @param signal - Abort signal from the action callback; cancels this press's own arm request and skips the cancelled-action warning
	 * @returns Resolves when this press's own request answered, or at once for a folded press
	 */
	async selectEvent(options?: CompanionOptionValues, signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this

		const resolved = self.resolveChosenEvent(options?.event)

		if (!resolved.event) {
			const id = resolved.reason === MSG_NOT_IN_PLAYLIST ? options?.event : undefined

			self.reportNotSent('arm', { id: id }, 'event', resolved.reason)
			return
		}

		await self.armEvent('arm', resolved.event, signal)
	},

	/**
	 * Arms one event (`POST /api/playlist/next-event`): single-flight, coalescing to the latest target
	 *
	 * At most one arm request is in flight. The first press sends its target and its
	 * callback awaits only that request. A press made while a request is in flight is
	 * folded in: it records its target as the latest one and returns at once. When the
	 * request settles, `runArmRequest()` sends one request for the latest target if it
	 * differs from the target just sent. There is no request queue and no blocking chain.
	 *
	 * `pendingArmId` holds the latest target from the first press until the last request
	 * settles, so Arm Next / Previous step from it. A throw from the request resets the
	 * flight and `pendingArmId` and is logged once, so the next press starts a fresh flight.
	 *
	 * @param verb - `action:` verb (`arm`, `arm next` or `arm previous`)
	 * @param event - Event to arm
	 * @param signal - Abort signal of the press that leads a new flight; a folded press sends nothing, so its signal is dropped
	 * @returns Resolves when this press's own request answered, or at once for a folded press
	 */
	async armEvent(verb: string, event: { ID: string; Name?: string }, signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this

		const press: ArmPress = {
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
			await self.runArmRequest(press, [], signal)
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
	 * folded into it. After the answer: the lead's line is logged by `reportActionResult`,
	 * each folded press logs its own line just before it, and RequestState is sent when the
	 * outcome is unknown. The presses that arrived meanwhile are then taken: when the last
	 * one's target differs, or the flight was dropped by a host or port change, a request
	 * for it starts in a fresh flight; otherwise they fold into this request, the flight
	 * ends, `pendingArmId` is cleared, and an accepted `ack.eventId` is applied as an
	 * optimistic arm until the next frame. Every settle path is a no-op after `destroy()`.
	 *
	 * @param lead - Press whose target this request carries
	 * @param folded - Presses that folded into this request, in press order
	 * @param signal - Abort signal of the lead press; omitted for the coalesced follow-up, which no live callback awaits
	 * @returns Resolves when the request has settled and any follow-up has been dispatched
	 */
	async runArmRequest(lead: ArmPress, folded: ArmPress[], signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this

		const result = await self.sendREST('/api/playlist/next-event', { nextEventID: lead.event.ID }, signal)

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
				signal: signal,
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

		// armFlight is always set while an arm request is in flight (armEvent / this method set it)
		if (flight === null) {
			return
		}

		const waiting = flight.waiting
		const next = waiting.at(-1)

		flight.waiting = []

		// After a host or port change this request went to the previous server, so a press
		// made since then is sent even when it names the same event ID (as on an HA pair)
		if (next !== undefined && (flight.dropped || next.event.ID !== lead.event.ID)) {
			if (flight.dropped) {
				self.armFlight = { waiting: [], dropped: false }
			}

			// The coalesced follow-up runs signal-free: the press that requested it has already
			// returned, so no live callback awaits it and its own signal may have settled; only the
			// REST timeout bounds it.
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

		if (report.accepted && !flight.dropped && result?.gen === self.attemptGen) {
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
	 * to the `to=` event. Copies only that request's `outcome=`, `http=` and `reason=`;
	 * BreakTime's `detail=` text is about the event that request carried, so it is left out
	 * whenever that event differs. Raises no warning.
	 *
	 * @param press - The folded press
	 * @param sentId - Event ID the request it folded into carried
	 * @param report - Report of the request it folded into
	 * @returns void
	 */
	logFoldedArm(press: ArmPress, sentId: string, report: ActionReport): void {
		const self: BreakTimeInstance = this

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
	 * Called by main.ts on a host or port change: a waiting target was picked from the old
	 * server's playlist and must not be sent to the new one. The request already in flight
	 * settles normally. The flight is marked dropped, so a press made after this call never
	 * folds into that old request. Each dropped press logs `outcome=NotSent` with no warning.
	 *
	 * @returns void
	 */
	dropWaitingArms(): void {
		const self: BreakTimeInstance = this

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
	 * @param options - Action options; `duration` is passed on as received, so a missing value is refused by `changeDuration`
	 * @param signal - Abort signal from the action callback; cancels the in-flight request and skips the cancelled-action warning
	 * @returns Resolves when BreakTime answered or the request was not sent
	 */
	async increaseDuration(options?: CompanionOptionValues, signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this
		await self.changeDuration('increaseDuration', 1, options?.duration, signal)
	},

	/**
	 * Armed Duration -: shortens the armed event's duration
	 *
	 * @param options - Action options; `duration` is passed on as received, so a missing value is refused by `changeDuration`
	 * @param signal - Abort signal from the action callback; cancels the in-flight request and skips the cancelled-action warning
	 * @returns Resolves when BreakTime answered or the request was not sent
	 */
	async decreaseDuration(options?: CompanionOptionValues, signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this
		await self.changeDuration('decreaseDuration', -1, options?.duration, signal)
	},

	/**
	 * Posts a signed duration delta for the armed event (`POST /api/playlist/events/{id}/duration`)
	 *
	 * Refused locally per `getDurationBlock()`, and for an amount that is not a whole number
	 * from 1 to 65535. A missing amount (undefined or null, which is how a Seconds expression
	 * that resolves to nothing arrives), a blank string and non-numeric text are refused the
	 * same way; no default is substituted, because a default would change the duration by an
	 * amount nobody set and report it as accepted. BreakTime clamps the result, so the module
	 * does no client-side clamping of the request. The expected result is held as the pending
	 * duration synchronously before the request. On a standby node the line carries
	 * `acting=false` and the `ha` warning is raised.
	 *
	 * @param warningType - Warning type for refusals
	 * @param sign - Direction
	 * @param amount - Option value: whole seconds as a number (or text from a 2.0.x button); undefined or null when the option has no value
	 * @param signal - Abort signal from the action callback; cancels the in-flight request and skips the cancelled-action warning
	 * @returns Resolves when BreakTime answered or the request was not sent
	 */
	async changeDuration(
		warningType: 'increaseDuration' | 'decreaseDuration',
		sign: 1 | -1,
		amount: JsonValue | undefined,
		signal?: AbortSignal,
	): Promise<void> {
		const self: BreakTimeInstance = this

		const armed = self.DATA.selectedEvent
		const fields: LogFields = armed ? { event: armed.Name, id: armed.ID } : {}
		const block = self.getDurationBlock()

		if (block) {
			self.reportNotSent('duration', fields, warningType, block)
			return
		}

		// getDurationBlock() returns '' only when an event is armed
		if (!armed) {
			return
		}

		// A missing or blank value is invalid, never a default. null is checked explicitly
		// because Number(null) is 0.
		const seconds =
			amount === undefined || amount === null || (typeof amount === 'string' && amount.trim() === '')
				? NaN
				: Number(amount)

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
		const base = self.getPendingDuration(armed.ID) ?? armed.DurationSeconds ?? NaN
		const standbyWarning = self.getStandbyWarning('duration')
		const previous = self.pendingDuration
		const entry = Number.isFinite(base)
			? self.setPendingDuration(armed.ID, clampDuration(base + delta, armed.MessageMode))
			: null

		fields.delta = delta

		const result = await self.sendREST(
			`/api/playlist/events/${encodeURIComponent(armed.ID)}/duration`,
			{ delta: delta },
			signal,
		)

		const report = self.reportActionResult(
			{
				verb: 'duration',
				kind: 'duration',
				fields: fields,
				warningType: warningType,
				acting: standbyWarning ? false : undefined,
				standbyWarning: standbyWarning,
				signal: signal,
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
	 * held as pending synchronously before the request. Same local guards as Armed Duration
	 * +/-, plus a target outside 6..6553 (Splice Insert) or 6..65535 (Time Signal). A missing
	 * `seconds` (undefined or null, which is how a Seconds expression that resolves to nothing
	 * arrives) is refused like any other value that is not a whole number; no default is
	 * substituted, because a default would set a duration nobody chose and report it as
	 * accepted. A delta of 0 sends nothing and raises no warning. Logged as `action: duration`
	 * with `delta=` and the target as `to=`.
	 *
	 * @param options - Action options
	 * @param signal - Abort signal from the action callback; cancels the in-flight request and skips the cancelled-action warning
	 * @returns Resolves when BreakTime answered or the request was not sent
	 */
	async setArmedDuration(options?: CompanionOptionValues, signal?: AbortSignal): Promise<void> {
		const self: BreakTimeInstance = this

		// A missing or blank value is invalid, never a default. null is checked explicitly
		// because Number(null) is 0.
		const amount = options?.seconds
		const seconds =
			amount === undefined || amount === null || (typeof amount === 'string' && amount.trim() === '')
				? NaN
				: Number(amount)
		const valid = Number.isInteger(seconds)
		const armed = self.DATA.selectedEvent
		const base = armed ? (self.getPendingDuration(armed.ID) ?? armed.DurationSeconds ?? NaN) : NaN

		let warningType = 'event'

		if (valid && Number.isFinite(base)) {
			warningType = seconds >= base ? 'increaseDuration' : 'decreaseDuration'
		}

		const fields: LogFields = armed ? { event: armed.Name, id: armed.ID } : {}
		const block = self.getDurationBlock()

		if (block) {
			self.reportNotSent('duration', { ...fields, to: valid ? seconds : undefined }, warningType, block)
			return
		}

		if (!valid) {
			self.reportNotSent('duration', fields, warningType, 'Duration must be a whole number of seconds')
			return
		}

		// getDurationBlock() returns '' only when an event is armed
		if (!armed) {
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

		const result = await self.sendREST(
			`/api/playlist/events/${encodeURIComponent(armed.ID)}/duration`,
			{ delta: delta },
			signal,
		)

		const report = self.reportActionResult(
			{
				verb: 'duration',
				kind: 'duration',
				fields: fields,
				warningType: warningType,
				acting: standbyWarning ? false : undefined,
				standbyWarning: standbyWarning,
				signal: signal,
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
	 * @param eventId - Event ID
	 * @param seconds - Expected duration in seconds
	 * @returns The new pending entry, for `settlePendingDuration`
	 */
	setPendingDuration(eventId: string, seconds: number): PendingDuration {
		const self: BreakTimeInstance = this

		const entry: PendingDuration = { id: eventId, seconds: seconds, until: Date.now() + PENDING_DURATION_MS }

		self.pendingDuration = entry
		self.refreshState()

		return entry
	},

	/**
	 * Settles a pending duration once its request has an answer
	 *
	 * Ownership is by entry identity, so a frame that already confirmed it or a later press
	 * that replaced it is left alone on success. Accepted and still current: the hold
	 * restarts from now. Refused and still current: the previous entry is restored. Refused
	 * after a later press on the same event replaced it: the held value is dropped. A no-op
	 * after `destroy()`.
	 *
	 * @param entry - Entry `setPendingDuration` returned for this press
	 * @param previous - Entry held before this press
	 * @param accepted - True when BreakTime accepted the change
	 * @returns void
	 */
	settlePendingDuration(entry: PendingDuration, previous: PendingDuration | null, accepted: boolean): void {
		const self: BreakTimeInstance = this

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
	 * Sets the warning text, flag and type and pushes the change, then clears all three after
	 * `duration`. The text is stored in its own field: `message` is computed from it by
	 * `getMessageText()` on every push, so on expiry `message` falls back to the current
	 * `HARoleAlarm` instead of going blank. A new warning replaces the active one and its
	 * timer, so timers never stack. Does not log. Both pushes go through `refreshState()`.
	 * The expiry does nothing after `destroy()`.
	 *
	 * @param type - Warning type, matched by the `temporaryWarning` feedback
	 * @param message - Warning text
	 * @param duration - Milliseconds before the warning clears; WARNING_MS when omitted
	 * @param deferPush - True from `processData()`, which pushes once at the end of the frame
	 * @returns void
	 */
	issueWarning(type: string, message: string, duration?: number, deferPush = false): void {
		const self: BreakTimeInstance = this

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
	 * @returns void
	 */
	closeConnection(): void {
		const self: BreakTimeInstance = this

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
	 * @param status - New connection status
	 * @param message - Status message; omitted or null for none
	 * @returns void
	 */
	setStatus(status: InstanceStatus, message: string | null = null): void {
		const self: BreakTimeInstance = this

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
	 * @param level - Companion log level
	 * @param area - Log area, e.g. `config` or `conn`
	 * @param verb - Verb from that area's closed list, e.g. `applied`
	 * @param fields - Key/value pairs from the fixed key vocabulary, in output order
	 * @returns void
	 */
	logEvent(level: LogLevel, area: string, verb: string, fields: LogFields = {}): void {
		const self: BreakTimeInstance = this

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
	 * @param key - Field key
	 * @param value - Field value; converted with `String()`
	 * @returns The value ready to follow `key=`
	 */
	formatLogValue(key: string, value: unknown): string {
		const self: BreakTimeInstance = this

		let text = String(value)

		// Cheap length check first: UTF-16 length is never below the code point count
		if (key === 'detail' && text.length > self.LOG_DETAIL_MAX) {
			let end = 0

			for (let count = 0; count < self.LOG_DETAIL_MAX && end < text.length; count++) {
				end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1
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
	 * @param command - Command text, e.g. `RequestState`
	 * @returns True when the command was handed to the socket
	 */
	sendWSCommand(command: string): boolean {
		const self: BreakTimeInstance = this

		const ws = self.WS

		if (!ws || ws.readyState !== WebSocket.OPEN) {
			return false
		}

		const fail = (error: unknown): void => {
			if (ws !== self.WS) {
				return
			}

			if (!self.closeReason) {
				self.closeReason = `Could not send to BreakTime: ${errorMessage(error)}`
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
	 * @returns void
	 */
	requestState(): void {
		const self: BreakTimeInstance = this
		self.sendWSCommand('RequestState')
	},

	/**
	 * Sends one form-encoded POST to BreakTime and returns what came back
	 *
	 * Never touches the status (the WebSocket owns it) and never throws: a timeout or
	 * network failure comes back as a result with `status` 0. Sends the API key when one
	 * is set. Returns null when the module was destroyed while the request ran. The result
	 * carries the attempt generation at send time (`gen`).
	 *
	 * @param path - Route path, e.g. `/api/playlist/next-event`
	 * @param form - Form fields, encoded by `encodeForm()`
	 * @param signal - Abort signal from the action callback, combined with the REST timeout; omit for internal sends
	 * @returns The result, or null after `destroy()`
	 */
	async sendREST(
		path: string,
		form: Record<string, boolean | number | string>,
		signal?: AbortSignal,
	): Promise<RestResult | null> {
		const self: BreakTimeInstance = this

		const gen = self.attemptGen

		const result = await self.restRequest(
			'POST',
			path,
			form,
			self.apiKey,
			{
				host: self.config.host,
				port: self.config.port,
				apiKey: self.apiKey,
			},
			signal,
		)

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
	 * @param method - HTTP method
	 * @param path - Route path
	 * @param form - Form fields for a POST, or undefined
	 * @param apiKey - API key to send, or '' to send none
	 * @param target - Host and port to send to
	 * @param signal - Optional caller abort signal, combined with the REST timeout so either one aborts the request
	 * @returns The result
	 */
	async restRequest(
		method: 'GET' | 'POST',
		path: string,
		form: Record<string, boolean | number | string> | undefined,
		apiKey: string,
		target: AttemptTarget,
		signal?: AbortSignal,
	): Promise<RestResult> {
		const self: BreakTimeInstance = this

		const started = Date.now()
		const headers = self.buildHeaders(apiKey)

		const options: RequestInit = {
			method: method,
			headers: headers,
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(self.REST_TIMEOUT_MS)])
				: AbortSignal.timeout(self.REST_TIMEOUT_MS),
		}

		if (form !== undefined) {
			headers['Content-Type'] = 'application/x-www-form-urlencoded'
			options.body = self.encodeForm(form)
		}

		let result: RestResult

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
			const err = error as { name?: string; cause?: { code?: unknown } }
			const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
			const code = err?.cause?.code

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
	 * booleans become the literal `true` / `false`, numbers are written with `String()` and
	 * must be whole, and GUID strings are passed through as given. Undefined and null fields
	 * are left out.
	 *
	 * @param form - Form fields
	 * @returns `application/x-www-form-urlencoded` body
	 */
	encodeForm(form: Record<string, boolean | number | string>): string {
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
	 * `firingId=`, `seq=` and `detail=` when the ack carries them. Every refusal outcome
	 * raises an `ack` warning with BreakTime's detail, except `DuplicateActuation`, and
	 * `AlreadyInThatState` on End, which are log-only. A 401 also terminates the WebSocket so
	 * the next attempt re-derives AuthenticationFailure, but only when the request was sent
	 * on the current attempt. When the response raised no warning and the spec carries a
	 * standby warning, the `ha` warning is raised instead. With `spec.deferWarning` the
	 * warning is returned in the report instead of raised. When `spec.signal` has aborted (the
	 * operator cancelled the running actions), the line is still logged but no warning is raised
	 * or deferred. Never auto-retries and never sends RequestState.
	 *
	 * @param spec - What was requested
	 * @param result - What `sendREST` returned; null after `destroy()`
	 * @returns What the response meant
	 */
	reportActionResult(spec: ActionSpec, result: RestResult | null): ActionReport {
		const self: BreakTimeInstance = this

		const report: ActionReport = {
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

		const fields: LogFields = { ...spec.fields }
		const ackRoute = spec.kind !== 'duration'

		let http: number | undefined
		let reason: string | undefined
		let detail: string | null | undefined
		let firingId: string | null | undefined
		let seq: number | null | undefined
		let warningType: string | null = null
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
				warningType = spec.warningType ?? null
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
				const errorBody = result.body as { error?: string } | null | undefined
				detail = errorBody?.error
				warningType = spec.warningType ?? null
				warningText = errorBody?.error || 'Event is running'
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

		// Operator cancelled the running actions: the request was aborted through the callback's
		// signal, so suppress the user-facing warning (the line above is still logged). A deferred
		// warning is dropped too, so End `all` does not surface one for a cancelled send.
		const aborted = spec.signal?.aborted === true

		if (warningType && !aborted) {
			if (spec.deferWarning) {
				report.warning = { type: warningType, text: warningText }
			} else {
				self.issueWarning(warningType, warningText, self.WARNING_MS)
			}
		}

		return report
	},

	/**
	 * Logs a gesture that sent nothing (`outcome=NotSent`) and raises its local-guard warning
	 *
	 * Local-guard warnings last WARNING_LOCAL_MS. Pass a null `warningType` for a guard that
	 * logs but shows nothing (Set Armed Duration "Already set").
	 *
	 * @param verb - `action:` verb
	 * @param fields - Leading log fields (target, event, id, ...)
	 * @param warningType - Warning type for the `temporaryWarning` feedback, or null for none
	 * @param reason - Module-authored reason, also the warning text
	 * @returns void
	 */
	reportNotSent(verb: string, fields: LogFields, warningType: string | null, reason: string): void {
		const self: BreakTimeInstance = this

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
	 * @param kind - Route family
	 * @returns Warning text
	 */
	outcomeUnknownText(kind: ActionKind): string {
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
	 * @returns void
	 */
	dropSocketForAuth(): void {
		const self: BreakTimeInstance = this

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
	 * @param ms - Time in milliseconds
	 * @param format - Output format
	 * @returns Seconds as a number for `ss`, otherwise a zero-padded string; '' for a non-finite input
	 */
	convertTime(ms: number | string, format: 'ss' | 'mm:ss' | 'hh:mm:ss'): number | string {
		// Make sure it's a number
		const value = Number(ms)

		if (!Number.isFinite(value)) {
			return ''
		}

		const seconds = Math.abs(Math.ceil(value / 1000))
		const minutes = Math.abs(Math.floor(seconds / 60))
		const hours = Math.abs(Math.floor(minutes / 60))

		if (format === 'ss') {
			return seconds
		} else if (format === 'mm:ss') {
			return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
		} else {
			return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
		}
	},
} satisfies ThisType<BreakTimeInstance>

/** The shape the `api` connection and action methods add to the module class */
export type ApiMixin = typeof api
