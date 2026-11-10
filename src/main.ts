/**
 * @fileoverview BreakTime module entry point: lifecycle, config and secrets
 *
 * Owns the module class, its per-instance state, and the config/secrets handling that
 * decides whether a config change needs a new connection attempt. Connection, actions,
 * feedbacks, variables, presets and the shared constants come from the mixins in `src/`, all
 * assigned onto the module class in the constructor, so every mixin method runs with `this`
 * as the instance. The mixins are typed with `ThisType<BreakTimeInstance>` and declared on
 * the class through interface declaration merging, so `this.<method>()` type-checks without
 * changing the runtime composition.
 *
 * Architecture map:
 * - `main.ts`: module class, constructor state, `init` / `configUpdated` / `destroy`,
 *   config and secret normalization, and the choice between keeping the socket and a new
 *   connection attempt. The default export is the instance class; `UpgradeScripts` is the
 *   named export base 2.x reads.
 * - `src/api.ts`: the connection lifecycle, the single status gate `setStatus()`, state-frame
 *   normalization (`processData()`), the REST client (`sendREST()`), every action handler
 *   body, timed warnings and the log line formatter (`logEvent()`). Also the BreakTime
 *   contract typedefs: StateFrame, BreakTimeEvent, HaState and FireAck.
 * - `src/actions.ts`: action definitions; each callback awaits its handler in api.ts.
 * - `src/feedbacks.ts`: feedback definitions plus the per-type and per-tile signatures used
 *   for change detection.
 * - `src/variables.ts`: variable definitions, the value builder, and `checkVariables()`,
 *   the one place that writes variable values.
 * - `src/presets.ts`: preset definitions and the section structure (styled building blocks).
 * - `src/configFields.ts`: the connection config form.
 * - `src/upgrades.ts`: append-only upgrade scripts (index 1 fills the 2.0 defaults).
 * - `src/defaults.ts`: constants, choice lists, shared colors, `formatClock()` and the
 *   `createDefaultData()` state factory.
 *
 * Data flow: a state frame arrives on the WebSocket, `processData()` normalizes it into
 * `this.DATA` and calls `checkVariables()`, which sends only the changed variables, feedback
 * types and tiles. Every other state change pushes through `refreshState()` in api.ts. A
 * null snapshot makes the next push a full one.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

import { InstanceBase, InstanceStatus } from '@companion-module/base'

import type {
	CompanionActionSchemaWithoutResult,
	CompanionAdvancedFeedbackSchema,
	CompanionBooleanFeedbackSchema,
	CompanionVariableValue,
	CompanionVariableValues,
	InstanceTypes,
	JsonObject,
} from '@companion-module/base'
import type WebSocket from 'ws'

import { configFields, type ConfigFieldsMixin } from './configFields.js'
import { actions, type ActionsMixin } from './actions.js'
import { feedbacks, type FeedbacksMixin } from './feedbacks.js'
import { variables, type VariablesMixin } from './variables.js'
import { presets, type PresetsMixin } from './presets.js'
import { api, type ApiMixin } from './api.js'
import { UpgradeScripts } from './upgrades.js'

import {
	defaults,
	createDefaultData,
	CHOICES_EVENTS_PLACEHOLDER,
	DEFAULT_RUNNING_SLOTS,
	MAX_RUNNING_SLOTS,
	PORT_REGEX,
	HOSTNAME_REGEX,
	MODULE_VERSION,
	type DefaultsMixin,
} from './defaults.js'

import type { BreakTimeData, Choice } from './defaults.js'
import type { ArmFlight, PendingDuration } from './api.js'

/**
 * Valid host: a hostname or IPv4 address, the same pattern the config form validates with
 * (`HOSTNAME_REGEX` is a `/.../` string). IPv6 literals are out of scope.
 */
const HOSTNAME_PATTERN = new RegExp(HOSTNAME_REGEX.slice(1, -1))

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
 *
 * A `JsonObject` intersection, so it stays assignable to the base `InstanceTypes['config']`
 * (and the upgrade `TConfig`) while still allowing the optional fields; an `interface ...
 * extends JsonObject` would reject the optional members against JsonObject's strict index
 * signature.
 */
export type Config = JsonObject & {
	/** BreakTime IP address or hostname */
	host: string
	/** BreakTime HTTP port */
	port: string
	/** Number of running-event variable slots; undefined on configs saved by 1.0.3 */
	runningSlots?: number
	/** Verbose Logging */
	verbose: boolean
	/** Log Raw BreakTime Data */
	verboseWebsocket: boolean
	/**
	 * Show Advanced Settings; config page display only, never read by the module; undefined on configs saved by 1.0.3
	 */
	showAdvanced?: boolean
}

/** Connection secrets as stored by Companion */
export type Secrets = JsonObject & {
	/** BreakTime API key; undefined until the user saves the config once */
	apiKey?: string
}

/**
 * Option value shape of each action, keyed by action id
 *
 * Typed against the option fields registered in `actions.ts`, so a misspelt `actionId` or option id in
 * a preset is a compile error instead of a runtime surprise. Dropdown values are the stored
 * `string | number`; `endSelected.event` is optional because it is only meaningful when Target is a
 * specific event (the latest/all presets omit it). The handlers' `?? default` fallbacks still cover an
 * option missing from a button saved before it existed, except the Seconds options (`duration`,
 * `seconds`): a missing value there is refused, never defaulted.
 */
export type ActionsSchema = {
	startSelected: CompanionActionSchemaWithoutResult<{
		event: string | number
		immediate: boolean
		onlyWhenIdle: boolean
	}>
	startArmed: CompanionActionSchemaWithoutResult<{ immediate: boolean }>
	endSelected: CompanionActionSchemaWithoutResult<{
		target: string | number
		event?: string | number
		immediate: boolean
	}>
	selectNextEvent: CompanionActionSchemaWithoutResult<Record<string, never>>
	selectPreviousEvent: CompanionActionSchemaWithoutResult<Record<string, never>>
	selectEvent: CompanionActionSchemaWithoutResult<{ event: string | number }>
	increaseDuration: CompanionActionSchemaWithoutResult<{ duration: number }>
	decreaseDuration: CompanionActionSchemaWithoutResult<{ duration: number }>
	setArmedDuration: CompanionActionSchemaWithoutResult<{ seconds: number }>
}

/**
 * Option value shape and kind of each feedback, keyed by feedback id
 *
 * As {@link ActionsSchema}, but for feedbacks, and it also carries each feedback's `type`, so a
 * preset boolean-feedback entry is required to provide a `style`. `eventTile` is the one advanced
 * feedback; every other feedback is boolean.
 */
export type FeedbacksSchema = {
	selectedIsRunning: CompanionBooleanFeedbackSchema<Record<string, never>>
	selectedisFinished: CompanionBooleanFeedbackSchema<Record<string, never>>
	selectedDurationMode: CompanionBooleanFeedbackSchema<{ mode: string | number }>
	IncDecNotAllowed: CompanionBooleanFeedbackSchema<Record<string, never>>
	armedDurationIs: CompanionBooleanFeedbackSchema<{ seconds: number }>
	eventIsRunning: CompanionBooleanFeedbackSchema<{ target: string | number; event: string | number }>
	runningRemainingBelow: CompanionBooleanFeedbackSchema<{ slot: number; seconds: number }>
	runningCountAtLeast: CompanionBooleanFeedbackSchema<{ count: number }>
	eventTile: CompanionAdvancedFeedbackSchema<{ event: string | number }>
	countingDown: CompanionBooleanFeedbackSchema<{ target: string | number }>
	remainingTimeBelow: CompanionBooleanFeedbackSchema<{ target: string | number; seconds: number }>
	vMixConnected: CompanionBooleanFeedbackSchema<Record<string, never>>
	vMixDisconnected: CompanionBooleanFeedbackSchema<Record<string, never>>
	scte104Connected: CompanionBooleanFeedbackSchema<Record<string, never>>
	scte104Disconnected: CompanionBooleanFeedbackSchema<Record<string, never>>
	componentStatus: CompanionBooleanFeedbackSchema<{ component: string | number; status: string | number }>
	haActing: CompanionBooleanFeedbackSchema<Record<string, never>>
	haStandby: CompanionBooleanFeedbackSchema<Record<string, never>>
	haRoleAlarmActive: CompanionBooleanFeedbackSchema<Record<string, never>>
	haLinkState: CompanionBooleanFeedbackSchema<{ state: string | number }>
	haEmitReady: CompanionBooleanFeedbackSchema<Record<string, never>>
	temporaryWarning: CompanionBooleanFeedbackSchema<{ warning: string | number }>
}

/** The generic manifest for InstanceBase: the module's config, secrets and typed entity sets */
export interface BreakTimeInstanceTypes extends InstanceTypes {
	config: Config
	secrets: Secrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: CompanionVariableValues
}

/** Config and secret values after normalization; the only form later code reads */
interface NormalizedSettings {
	/** Trimmed host */
	host: string
	/** Trimmed port */
	port: string
	/** Trimmed API key, '' when none is set */
	apiKey: string
	/** Integer slot count, clamped to 1..MAX_RUNNING_SLOTS */
	runningSlots: number
}

/** Last variable values and feedback inputs pushed to Companion; null forces a full push and a check of every feedback */
export interface Snapshot {
	/** Last value pushed per variable ID */
	values: Record<string, CompanionVariableValue>
	/** Last signature pushed per feedback type */
	feedbacks: Record<string, string | number | boolean | undefined>
	/** Last signature pushed per event an `eventTile` shows, keyed by event ID */
	tiles: Record<string, string>
}

/**
 * The module class, with the mixin method and constant members declared through declaration
 * merging so `this.<method>()` and `this.<CONST>` type-check. The class/interface merge is
 * intentional: the mixin objects are spread onto the instance in the constructor, so the
 * members the interface declares exist at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- intentional typed-mixin merge
export interface BreakTimeInstance
	extends ConfigFieldsMixin, ActionsMixin, FeedbacksMixin, VariablesMixin, PresetsMixin, DefaultsMixin, ApiMixin {}

/**
 * Middleman Software BreakTime control module
 *
 * Connects to one BreakTime 2.0 server, mirrors its state frames into variables and
 * feedbacks, and drives events through the BreakTime REST API.
 *
 * @extends InstanceBase<BreakTimeInstanceTypes>
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- intentional typed-mixin merge
export class BreakTimeInstance extends InstanceBase<BreakTimeInstanceTypes> {
	/** Companion config, with host, port and runningSlots replaced by their normalized values */
	config: Config = { host: '', port: '', verbose: false, verboseWebsocket: false }

	/** Secrets as received from Companion; later code reads `apiKey` instead */
	secrets: Secrets = {}

	/** Normalized API key, '' when none is set */
	apiKey = ''

	/** BreakTime state cache, rebuilt from each state frame */
	DATA: BreakTimeData = createDefaultData()

	/** Event dropdown choices, rebuilt when the playlist changes */
	CHOICES_EVENTS: Choice[] = [...CHOICES_EVENTS_PLACEHOLDER]

	/** State-frame WebSocket, or null while not connected */
	WS: WebSocket | null = null

	/** The single re-attempt timer; every reconnect and re-check is scheduled through it */
	RETRY_TIMEOUT: NodeJS.Timeout | null = null

	/** Frame watchdog timer; fires when no state frame arrives within WATCHDOG_MS */
	WATCHDOG_TIMEOUT: NodeJS.Timeout | null = null

	/** Timer that clears the active timed warning */
	WARNING_TIMEOUT: NodeJS.Timeout | null = null

	/** Set by `destroy()`; blocks re-attempts and late callbacks */
	destroyed = false

	/** Connection attempt generation; bumped by `closeConnection()` so stale attempt continuations can detect themselves */
	attemptGen = 0

	/** Status the current attempt's non-101 WebSocket handshake response set, or null; reset on every attempt */
	handshakeOutcome: { status: InstanceStatus } | null = null

	/** Why the current socket is closing (watchdog trip, send failure, socket error), '' when unknown; reset per socket */
	closeReason = ''

	/** Last variable values and feedback inputs pushed to Companion; null forces a full push and a check of every feedback */
	snapshot: Snapshot | null = null

	/**
	 * Event shown by each `eventTile` feedback instance, so a frame re-checks only the tiles whose event changed.
	 * Keyed by feedback instance ID; filled by the tile callback for events in the playlist, emptied by its
	 * unsubscribe, and pruned when the event choices are rebuilt. Kept across host changes.
	 */
	tileFeedbacks = new Map<string, string>()

	/**
	 * Event shown by each `eventTile` feedback instance whose event is not in the playlist; never checked per
	 * frame, it only keeps those events' names in `DATA.eventNames` when the event choices are rebuilt.
	 */
	unlistedTileFeedbacks = new Map<string, string>()

	/**
	 * Ordered event IDs and names the event choices were last built from, flattened; null forces a rebuild on
	 * the next frame. Example: ['6f1c2a7e-...', 'Event 1', '1a2b3c4d-...', 'Event 2']
	 */
	eventListKeys: string[] | null = null

	/** Latest arm target while an arm request is in flight (rapid Arm Next/Previous presses step from it), or null */
	pendingArmId: string | null = null

	/** The arm request in flight and the presses folded into it, or null when no arm request is in flight */
	armFlight: ArmFlight | null = null

	/** Set Armed Duration target no state frame shows yet, or null */
	pendingDuration: PendingDuration | null = null

	/**
	 * Time (`performance.now()`, ms) of the last Start or End press that sent a request, keyed by press target
	 * (e.g. `start:armed`, `start:<eventId>`, `end:latest`, `end:all`, `end:specific:<eventId>`). A further press
	 * of the same target within PRESS_DEBOUNCE_MS is ignored; a press of a different target is not, so a button
	 * with two differently-targeted Start (or End) actions no longer drops the second. Cleared when the connection
	 * is lost and when the host or port changes.
	 */
	pressSentAt = new Map<string, number>()

	/** Names of conditions already logged, so a repeating condition logs once until it clears */
	logLatches = new Set<string>()

	/** Connection attempts since the connection was lost */
	attempts = 0

	/** Time the connection was lost (ms since epoch), or null while connected */
	lostAt: number | null = null

	/** Last status passed to Companion by `setStatus()` */
	lastStatus: InstanceStatus | null = null

	/** Last status message passed to Companion by `setStatus()` */
	lastStatusMessage: string | null = null

	/**
	 * Creates the module instance and its per-instance state
	 *
	 * @param internal - Companion internal handle, passed through to InstanceBase
	 */
	constructor(internal: unknown) {
		super(internal)

		// Assign the mixin methods and shared constants onto this instance
		Object.assign(this, {
			...configFields,
			...actions,
			...feedbacks,
			...variables,
			...presets,
			...defaults,
			...api,
		})
	}

	/**
	 * Module initialization: stores config and secrets, registers definitions and starts a connection attempt
	 *
	 * The attempt is not awaited: the pre-connect checks alone can take about 8 s
	 * (2 x REST_TIMEOUT_MS), longer than Companion's 5 s `updateConfigAndLabel` IPC
	 * timeout, and a full attempt with the 5 s WebSocket handshake can exceed the 10 s init
	 * IPC timeout. The attempt promise ends in its own `.catch` (see `startConnectAttempt`).
	 *
	 * @param config - Connection config from Companion
	 * @param _isFirstInit - True on first creation (unused)
	 * @param secrets - Connection secrets; undefined or {} on connections upgraded from 1.0.3
	 * @returns Resolves once definitions are registered and the attempt has started
	 */
	async init(config: Config, _isFirstInit: boolean, secrets?: Secrets): Promise<void> {
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
	 * is kept and the status is never touched. When the module is instead waiting on the
	 * re-attempt timer, the timer is cleared and an attempt starts at once, still without
	 * setting Connecting. `config: applied` is logged only when a normalized setting changed.
	 *
	 * @param config - Connection config from Companion
	 * @param secrets - Connection secrets
	 * @returns Resolves once the change has been applied
	 */
	async configUpdated(config: Config, secrets?: Secrets): Promise<void> {
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
	 * @returns Current values
	 */
	getLoggedSettings(): Record<string, string | number | boolean | undefined> {
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
	 * or {} until the user saves. A cleared slot count falls back to DEFAULT_RUNNING_SLOTS;
	 * only a real number is floored and clamped, because number field `min`/`max` are UI
	 * hints only.
	 *
	 * @param config - Connection config from Companion
	 * @param secrets - Connection secrets
	 * @returns Normalized values
	 */
	normalizeSettings(config?: Config, secrets?: Secrets): NormalizedSettings {
		// Companion's number field yields '' when cleared, so treat the stored value as unknown here
		const rawSlots: unknown = config?.runningSlots
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
	 * @param config - Connection config from Companion
	 * @param secrets - Connection secrets
	 * @returns The values now stored on the instance
	 */
	applySettings(config: Config, secrets?: Secrets): NormalizedSettings {
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
	 * @returns void
	 */
	logConfigApplied(): void {
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
	 * Also rejects an API key that is not header-safe, which would otherwise fail every
	 * request as an unreachable server and retry forever.
	 *
	 * @returns Status message for BadConfig, or ''
	 */
	getConfigProblem(): string {
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
	 * Not awaited by its callers. Closes any open socket first; when that socket had reached
	 * Ok, its frame-derived state is blanked through the disconnect hook. Sets Connecting:
	 * this is the config-driven start, unlike timer re-attempts.
	 *
	 * @returns void
	 */
	startAttempt(): void {
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
	 * Called before reconnecting to a different host or port, so nothing from the old server
	 * is shown while the new one connects. Rebuilds everything that lists events, drops the
	 * pending duration and the arm presses still waiting to be sent, releases the press
	 * debounce windows, then pushes the blanked values with a full push.
	 *
	 * @returns void
	 */
	resetEndpointState(): void {
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
	 * IDs as '', so every current value is pushed again at once. The null snapshot also
	 * re-checks every feedback type. Before the push, the slot assignment re-runs from the
	 * last frame without a reconnect.
	 *
	 * @returns void
	 */
	applyRunningSlots(): void {
		this.initVariables()
		this.initPresets()
		this.assignRunningSlots()

		this.snapshot = null
		this.refreshState()
	}

	/**
	 * Shuts the module down: closes the connection, clears every timer and the running slot assignments
	 *
	 * @returns Resolves once teardown is complete
	 */
	async destroy(): Promise<void> {
		this.destroyed = true

		this.closeConnection()
		this.DATA.slotByEventId.clear()

		if (this.WARNING_TIMEOUT) {
			clearTimeout(this.WARNING_TIMEOUT)
			this.WARNING_TIMEOUT = null
		}
	}
}

export default BreakTimeInstance
export { UpgradeScripts }
