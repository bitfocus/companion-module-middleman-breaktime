/**
 * @fileoverview BreakTime module entry point: lifecycle, config and secrets
 *
 * Owns the module class, its per-instance state, and the config/secrets handling that
 * decides whether a config change needs a new connection attempt. Connection, actions,
 * feedbacks, variables and presets come from the mixins in `src/`, all assigned onto the
 * module class in the constructor, so every mixin method runs with `this` as the instance.
 *
 * Architecture map:
 * - `index.js`: module class, constructor state, `init` / `configUpdated` / `destroy`,
 *   config and secret normalization, and the choice between keeping the socket and a new
 *   connection attempt.
 * - `src/api.js`: the connection lifecycle (pre-connect `whoami` and `version` checks,
 *   the `/api/ws` state-frame WebSocket, frame watchdog, single re-attempt timer), the
 *   single status gate `setStatus()`, state-frame normalization (`processData()`), the
 *   REST client (`sendREST()`) and its response rules, every action handler body, timed
 *   warnings and the log line formatter (`logEvent()`). Also the BreakTime contract
 *   typedefs: StateFrame, BreakTimeEvent, HaState and FireAck.
 * - `src/actions.js`: action definitions; each callback awaits its handler in api.js.
 * - `src/feedbacks.js`: feedback definitions plus the per-type and per-tile signatures
 *   used for change detection.
 * - `src/variables.js`: variable definitions, the value builder, and `checkVariables()`,
 *   the one place that writes variable values. It also runs the change-detected feedback
 *   checks: by type, and by instance ID for `eventTile`. The only other feedback check is
 *   in `rebuildEventChoices()` (api.js), which re-checks every `eventTile` once when the
 *   playlist changes.
 * - `src/presets.js`: preset definitions, including the Operator Panel.
 * - `src/configFields.js`: the connection config form.
 * - `src/upgrades.js`: append-only upgrade scripts (index 1 fills the 2.0 defaults).
 * - `src/defaults.js`: constants, choice lists, shared colors, `formatClock()` and the
 *   `createDefaultData()` state factory.
 *
 * Data flow: a state frame arrives on the WebSocket, and `processData()` normalizes it
 * into `this.DATA` (including the fixed running slots, `assignRunningSlots()`) and calls
 * `checkVariables()`. That compares the new values and feedback signatures with a
 * snapshot of what was last pushed and sends only the changes: one `setVariableValues()`
 * with the changed variables, one `checkFeedbacks()` with the affected types and one
 * `checkFeedbacksById()` with the affected tiles. Every other state change (init, a
 * config change, a pre-connect check result, a timed warning and its expiry, a
 * disconnect, a pending duration, an accepted arm) pushes through `refreshState()` in
 * api.js, which runs the same `checkVariables()` with any throw contained. A null
 * snapshot makes the next push a full one (every value, every feedback type).
 * Definitions are re-registered only when they change: actions, feedbacks and presets
 * when the event list or the host or port changes, variables and presets when the
 * running slot count changes. Actions read `this.DATA` for local guards, post to
 * BreakTime through `sendREST()`, and log one `action:` line per gesture.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

const { InstanceBase, InstanceStatus, Regex, runEntrypoint } = require('@companion-module/base')

const { version: MODULE_VERSION } = require('./package.json')

const UpgradeScripts = require('./src/upgrades')

const configFields = require('./src/configFields')
const actions = require('./src/actions')
const feedbacks = require('./src/feedbacks')
const variables = require('./src/variables')
const presets = require('./src/presets')

const defaults = require('./src/defaults')
const api = require('./src/api')

const { createDefaultData, CHOICES_EVENTS_PLACEHOLDER, DEFAULT_RUNNING_SLOTS, MAX_RUNNING_SLOTS, PORT_REGEX } = defaults

/**
 * Valid host: a hostname or IPv4 address, the same pattern the config form validates with
 * (`Regex.HOSTNAME` is a `/.../` string). IPv6 literals are out of scope.
 */
const HOSTNAME_PATTERN = new RegExp(Regex.HOSTNAME.slice(1, -1))

/**
 * Valid port text: 1 to 65535, optional leading zeros. The same pattern the config form
 * validates with (`PORT_REGEX` is a `/.../` string), so the form and the module agree.
 */
const PORT_PATTERN = new RegExp(PORT_REGEX.slice(1, -1))

/**
 * Valid API key text: printable ASCII without spaces, the only characters safe in a request
 * header. Checked before any request, because a rejected header makes fetch fail with an
 * error that names the value.
 */
const API_KEY_PATTERN = /^[\x21-\x7E]+$/

/** Highest TCP port number */
const MAX_PORT = 65535

/**
 * Connection config as stored by Companion
 * @typedef {Object} Config
 * @property {string} host - BreakTime IP address or hostname
 * @property {string} port - BreakTime HTTP port
 * @property {number} [runningSlots] - Number of running-event variable slots; undefined on configs saved by 1.0.3
 * @property {boolean} verbose - Verbose Logging
 * @property {boolean} verboseWebsocket - Log Raw BreakTime Data
 * @property {boolean} [showAdvanced] - Show Advanced Settings; config page display only, never read by the
 *   module; undefined on configs saved by 1.0.3
 */

/**
 * Connection secrets as stored by Companion
 * @typedef {Object} Secrets
 * @property {string} [apiKey] - BreakTime API key; undefined until the user saves the config once
 */

/**
 * Config and secret values after normalization; the only form later code reads
 * @typedef {Object} NormalizedSettings
 * @property {string} host - Trimmed host
 * @property {string} port - Trimmed port
 * @property {string} apiKey - Trimmed API key, '' when none is set
 * @property {number} runningSlots - Integer slot count, clamped to 1..MAX_RUNNING_SLOTS
 */

/**
 * Middleman Software BreakTime control module
 *
 * Connects to one BreakTime 2.0 server, mirrors its state frames into variables and
 * feedbacks, and drives events through the BreakTime REST API.
 *
 * @extends InstanceBase<Config, Secrets>
 */
class BreakTimeInstance extends InstanceBase {
	/**
	 * Creates the module instance and its per-instance state
	 *
	 * @param {unknown} internal - Companion internal handle, passed through to InstanceBase
	 */
	constructor(internal) {
		super(internal)

		// Assign the methods from the listed files to this class
		Object.assign(this, {
			...configFields,
			...actions,
			...feedbacks,
			...variables,
			...presets,
			...defaults,
			...api,
		})

		/**
		 * Companion config, with host, port and runningSlots replaced by their normalized values
		 * @type {Config}
		 */
		this.config = {}

		/**
		 * Secrets as received from Companion; later code reads `apiKey` instead
		 * @type {Secrets}
		 */
		this.secrets = {}

		/**
		 * Normalized API key, '' when none is set
		 * @type {string}
		 */
		this.apiKey = ''

		/**
		 * BreakTime state cache, rebuilt from each state frame
		 * @type {import('./src/defaults').BreakTimeData}
		 */
		this.DATA = createDefaultData()

		/**
		 * Event dropdown choices, rebuilt when the playlist changes
		 * @type {{id: string, label: string}[]}
		 */
		this.CHOICES_EVENTS = [...CHOICES_EVENTS_PLACEHOLDER]

		/**
		 * State-frame WebSocket, or null while not connected
		 * @type {import('ws')|null}
		 */
		this.WS = null

		/**
		 * The single re-attempt timer; every reconnect and re-check is scheduled through it
		 * @type {NodeJS.Timeout|null}
		 */
		this.RETRY_TIMEOUT = null

		/**
		 * Frame watchdog timer; fires when no state frame arrives within WATCHDOG_MS
		 * @type {NodeJS.Timeout|null}
		 */
		this.WATCHDOG_TIMEOUT = null

		/**
		 * Timer that clears the active timed warning
		 * @type {NodeJS.Timeout|null}
		 */
		this.WARNING_TIMEOUT = null

		/**
		 * Set by `destroy()`; blocks re-attempts and late callbacks
		 * @type {boolean}
		 */
		this.destroyed = false

		/**
		 * Connection attempt generation; bumped by `closeConnection()` so stale attempt continuations can detect themselves
		 * @type {number}
		 */
		this.attemptGen = 0

		/**
		 * Status the current attempt's non-101 WebSocket handshake response set, or null; reset on every attempt
		 * @type {{status: import('@companion-module/base').InstanceStatus}|null}
		 */
		this.handshakeOutcome = null

		/**
		 * Why the current socket is closing (watchdog trip, send failure, socket error), '' when unknown; reset per socket
		 * @type {string}
		 */
		this.closeReason = ''

		/**
		 * Last variable values and feedback inputs pushed to Companion; null forces a full push and a check of every feedback
		 * Structure: { values: { [variableId]: value }, feedbacks: { [feedbackType]: signature },
		 *   tiles: { [eventId]: signature } }
		 * @type {{values: Object<string, *>, feedbacks: Object<string, *>, tiles: Object<string, string>}|null}
		 */
		this.snapshot = null

		/**
		 * Event shown by each `eventTile` feedback instance, so a frame re-checks only the tiles whose event changed
		 * Structure: Map<feedbackInstanceId, eventId>; filled by the tile callback for events in the playlist, emptied by
		 * its unsubscribe, and pruned of events no longer in the playlist when the event choices are rebuilt (those
		 * tiles move to `unlistedTileFeedbacks`).
		 * Kept across host changes: the feedback instances belong to Companion, not to the server.
		 * @type {Map<string, string>}
		 */
		this.tileFeedbacks = new Map()

		/**
		 * Event shown by each `eventTile` feedback instance whose event is not in the playlist; never checked per
		 * frame, it only keeps those events' names in `DATA.eventNames` when the event choices are rebuilt
		 * Structure: Map<feedbackInstanceId, eventId>; filled by the tile callback and the rebuild, emptied by the
		 * tile's unsubscribe or when its event is back in the playlist. Kept across host changes, as `tileFeedbacks`.
		 * @type {Map<string, string>}
		 */
		this.unlistedTileFeedbacks = new Map()

		/**
		 * Ordered event IDs and names the event choices were last built from, flattened; null forces a rebuild on
		 * the next frame
		 * Example: ['6f1c2a7e-...', 'Event 1', '1a2b3c4d-...', 'Event 2']
		 * @type {Array<string>|null}
		 */
		this.eventListKeys = null

		/**
		 * Latest arm target while an arm request is in flight (rapid Arm Next/Previous presses step from it), or null
		 * @type {string|null}
		 */
		this.pendingArmId = null

		/**
		 * The arm request in flight and the presses folded into it, or null when no arm request is in flight
		 * @type {import('./src/api').ArmFlight|null}
		 */
		this.armFlight = null

		/**
		 * Set Armed Duration target no state frame shows yet, or null
		 * @type {import('./src/api').PendingDuration|null}
		 */
		this.pendingDuration = null

		/**
		 * Time (`performance.now()`, ms) of the last Start and the last End press that sent a request, null when its
		 * debounce window is released; a further press of the same group within PRESS_DEBOUNCE_MS is ignored
		 * @type {{start: number|null, end: number|null}}
		 */
		this.pressSentAt = { start: null, end: null }

		/**
		 * Names of conditions already logged, so a repeating condition logs once until it clears
		 * @type {Set<string>}
		 */
		this.logLatches = new Set()

		/**
		 * Connection attempts since the connection was lost
		 * @type {number}
		 */
		this.attempts = 0

		/**
		 * Time the connection was lost (ms since epoch), or null while connected
		 * @type {number|null}
		 */
		this.lostAt = null

		/**
		 * Last status passed to Companion by `setStatus()`
		 * @type {import('@companion-module/base').InstanceStatus|null}
		 */
		this.lastStatus = null

		/**
		 * Last status message passed to Companion by `setStatus()`
		 * @type {string|null}
		 */
		this.lastStatusMessage = null
	}

	/**
	 * Module initialization: stores config and secrets, registers definitions and starts a connection attempt
	 *
	 * The attempt is not awaited: the pre-connect checks alone can take about 8 s
	 * (2 x REST_TIMEOUT_MS), longer than Companion's 5 s `updateConfigAndLabel` IPC
	 * timeout, and a full attempt with the 5 s WebSocket handshake can exceed the 10 s init
	 * IPC timeout. The attempt promise ends in its own `.catch` (see `startConnectAttempt`).
	 *
	 * @async
	 * @param {Config} config - Connection config from Companion
	 * @param {boolean} _isFirstInit - True on first creation (unused)
	 * @param {Secrets} [secrets] - Connection secrets; undefined or {} on connections upgraded from 1.0.3
	 * @returns {Promise<void>}
	 */
	async init(config, _isFirstInit, secrets) {
		this.applySettings(config, secrets)
		this.logConfigApplied()

		this.initActions()
		this.initFeedbacks()
		this.initVariables()
		this.initPresets()

		this.snapshot = null
		this.refreshState()

		this.startAttempt()
	}

	/**
	 * Applies a config or secrets change, reconnecting only when the connection target changed
	 *
	 * Companion also calls this when the connection label is renamed. With host, port and
	 * API key unchanged (compared after normalization) a live socket or an attempt in flight
	 * is kept and the status is never touched, so toggling Verbose or Show Advanced Settings
	 * or renaming the label never flashes Connecting. When the module is instead waiting on
	 * the re-attempt timer (pre-2.0 BadConfig, AuthenticationFailure, ConnectionFailure), the
	 * timer is cleared and an attempt starts at once, still without setting Connecting.
	 *
	 * `config: applied` is logged only when a normalized setting changed, so a label-only
	 * rename logs nothing.
	 *
	 * @async
	 * @param {Config} config - Connection config from Companion
	 * @param {Secrets} [secrets] - Connection secrets
	 * @returns {Promise<void>}
	 */
	async configUpdated(config, secrets) {
		const previous = this.getLoggedSettings()

		this.applySettings(config, secrets)

		const current = this.getLoggedSettings()

		if (Object.keys(current).some((key) => current[key] !== previous[key])) {
			this.logConfigApplied()
		}

		const endpointChanged = current.host !== previous.host || current.port !== previous.port

		if (endpointChanged) {
			this.resetEndpointState()
		}

		if (current.runningSlots !== previous.runningSlots) {
			this.applyRunningSlots()
		}

		if (endpointChanged || current.apiKey !== previous.apiKey) {
			this.startAttempt()
		} else if (this.RETRY_TIMEOUT) {
			this.startConnectAttempt()
		}
	}

	/**
	 * Returns the normalized settings whose change is logged as `config: applied`
	 *
	 * `showAdvanced` is left out on purpose: it only changes what the config page shows,
	 * so saving it alone logs nothing.
	 *
	 * @private
	 * @returns {{host: string, port: string, apiKey: string, runningSlots: number, verbose: boolean,
	 *   verboseWebsocket: boolean}} Current values
	 */
	getLoggedSettings() {
		return {
			host: this.config.host,
			port: this.config.port,
			apiKey: this.apiKey,
			runningSlots: this.config.runningSlots,
			verbose: !!this.config.verbose,
			verboseWebsocket: !!this.config.verboseWebsocket,
		}
	}

	/**
	 * Normalizes config and secrets into the values every later read uses
	 *
	 * Base applies config and secret defaults only on first init, so a connection
	 * upgraded from 1.0.3 arrives with `runningSlots` undefined and `secrets` undefined
	 * or {} until the user saves. A cleared slot count ('' or whitespace only, null,
	 * undefined or non-finite) falls back to DEFAULT_RUNNING_SLOTS; only a real number is
	 * floored and clamped, because number field `min`/`max` are UI hints only.
	 *
	 * @param {Config} [config] - Connection config from Companion
	 * @param {Secrets} [secrets] - Connection secrets
	 * @returns {NormalizedSettings} Normalized values
	 */
	normalizeSettings(config, secrets) {
		const rawSlots = config?.runningSlots
		const cleared =
			rawSlots === null || rawSlots === undefined || (typeof rawSlots === 'string' && rawSlots.trim() === '')
		const slots = cleared ? NaN : Math.floor(Number(rawSlots))

		return {
			host: String(config?.host ?? '').trim(),
			port: String(config?.port ?? '').trim(),
			apiKey: String(secrets?.apiKey ?? '').trim(),
			runningSlots: Number.isFinite(slots)
				? Math.min(Math.max(slots, 1), MAX_RUNNING_SLOTS)
				: DEFAULT_RUNNING_SLOTS,
		}
	}

	/**
	 * Normalizes and stores config and secrets
	 *
	 * @private
	 * @param {Config} [config] - Connection config from Companion
	 * @param {Secrets} [secrets] - Connection secrets
	 * @returns {NormalizedSettings} The values now stored on the instance
	 */
	applySettings(config, secrets) {
		const settings = this.normalizeSettings(config, secrets)

		this.config = {
			...config,
			host: settings.host,
			port: settings.port,
			runningSlots: settings.runningSlots,
		}
		this.secrets = secrets ?? {}
		this.apiKey = settings.apiKey

		return settings
	}

	/**
	 * Logs the `config: applied` line from the normalized values; never logs the key itself
	 *
	 * @private
	 * @returns {void}
	 */
	logConfigApplied() {
		this.logEvent('info', 'config', 'applied', {
			module: MODULE_VERSION,
			host: `${this.config.host}:${this.config.port}`,
			key: this.apiKey ? 'set' : 'empty',
			slots: this.config.runningSlots,
		})
	}

	/**
	 * Returns why the stored config cannot be used to connect, or '' when it can
	 *
	 * Rejects a blank, malformed or out-of-range host or port up front: a host with an
	 * internal space or a non-numeric port would otherwise make `new WebSocket` throw.
	 * Also rejects an API key that is not header-safe (an internal CR/LF from an import,
	 * or a pasted zero-width space), which would otherwise fail every request as an
	 * unreachable server and retry forever.
	 *
	 * @private
	 * @returns {string} Status message for BadConfig, or ''
	 */
	getConfigProblem() {
		const { host, port } = this.config

		if (!host && !port) {
			return 'Host and port are required'
		}

		if (!host) {
			return 'Host is required'
		}

		if (!port) {
			return 'Port is required'
		}

		if (!HOSTNAME_PATTERN.test(host)) {
			return 'Host is not a valid hostname or IP address'
		}

		if (!PORT_PATTERN.test(port)) {
			return `Port must be a number from 1 to ${MAX_PORT}`
		}

		if (this.apiKey && !API_KEY_PATTERN.test(this.apiKey)) {
			return 'API key contains invalid characters'
		}

		return ''
	}

	/**
	 * Starts a full connection attempt, or reports BadConfig when host or port is unusable
	 *
	 * Not awaited by its callers. Closes any open socket first; when that socket had
	 * reached Ok, its frame-derived state is blanked through the disconnect hook, so the
	 * module never keeps showing state from a target it no longer uses. Sets Connecting:
	 * this is the config-driven start, unlike timer re-attempts.
	 *
	 * @private
	 * @returns {void}
	 */
	startAttempt() {
		const wasLive = this.lastStatus === InstanceStatus.Ok

		this.closeConnection()

		if (wasLive) {
			this.handleDisconnect()
		}

		const reason = this.getConfigProblem()

		if (reason) {
			this.setStatus(InstanceStatus.BadConfig, reason)
			this.logEvent('error', 'config', 'invalid', {
				host: `${this.config.host}:${this.config.port}`,
				status: InstanceStatus.BadConfig,
				reason: reason,
			})
			return
		}

		this.setStatus(InstanceStatus.Connecting)
		this.initConnection()
	}

	/**
	 * Drops all state that belongs to the previous host or port
	 *
	 * Called before reconnecting to a different host or port, so nothing from the old
	 * server is shown while the new one connects. The fresh state also clears the running
	 * slot assignments, so the new server's running events get slots oldest first.
	 * Rebuilds everything that lists events (actions, feedbacks and the Operator Panel
	 * presets) so the event dropdowns show the placeholder again and no event tile names an
	 * old event. Drops the pending duration and the arm presses still waiting to be sent:
	 * an arm request already in flight settles normally, and a press made meanwhile is sent
	 * to the new server. Releases the Start and End press debounce windows, so the first
	 * press to the new server acts at once. Then pushes the blanked values; the null snapshot makes that a full
	 * push and a check of every feedback.
	 *
	 * @private
	 * @returns {void}
	 */
	resetEndpointState() {
		this.DATA = createDefaultData()
		this.CHOICES_EVENTS = [...CHOICES_EVENTS_PLACEHOLDER]
		this.eventListKeys = null
		this.dropWaitingArms()
		this.pendingDuration = null
		this.releasePressWindows()
		this.snapshot = null

		this.initActions()
		this.initFeedbacks()
		this.initPresets()

		this.refreshState()
	}

	/**
	 * Re-registers variables and presets after the running slot count changed
	 *
	 * `setVariableDefinitions` replaces the whole set, and base re-seeds re-added variable
	 * IDs as '', so every current value is pushed again at once (slots 4 to 2 to 4 would
	 * otherwise leave `running_3_*` blank until those values next change). The null
	 * snapshot also re-checks every feedback type, `runningRemainingBelow` included.
	 * Before the push, the slot assignment re-runs from the last frame without a
	 * reconnect: a lower count frees the slots above it, and a higher count gives running
	 * events that had no slot one at once. Events within the count keep their slots.
	 *
	 * @private
	 * @returns {void}
	 */
	applyRunningSlots() {
		this.initVariables()
		this.initPresets()
		this.assignRunningSlots()

		this.snapshot = null
		this.refreshState()
	}

	/**
	 * Shuts the module down: closes the connection, clears every timer and the running slot assignments
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	async destroy() {
		this.destroyed = true

		this.closeConnection()
		this.DATA.slotByEventId.clear()

		if (this.WARNING_TIMEOUT) {
			clearTimeout(this.WARNING_TIMEOUT)
			this.WARNING_TIMEOUT = null
		}
	}
}

runEntrypoint(BreakTimeInstance, UpgradeScripts)
