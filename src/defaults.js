/**
 * @fileoverview Constants, choice lists, shared colors, the START on-air frame image and the default data factory
 *
 * Mixed into the module class alongside the other mixins, so every export is also
 * readable as `this.<NAME>`; api.js, feedbacks.js, presets.js and variables.js also
 * `require()` the values they use at module level. Holds no per-instance state: the
 * constructor owns that, and `createDefaultData()` returns a fresh state object each time
 * it is called. The only other functions are `formatClock()`, shared by the tile text and
 * the Operator Panel labels, and `literalButtonText()`, which keeps an event name literal
 * on a button.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

const { combineRgb } = require('@companion-module/base')

/**
 * Per-connection BreakTime state cache, normalized from each state frame by `processData()`
 *
 * While the WebSocket is down (`handleDisconnect()`), `events` and `selectedEvent` keep only
 * `ID` and `Name`, `running` is empty, `runningEventsCount` is '', both connectivity
 * buckets and every component read `Unknown`, `ha` is null and `haRoleAlarm` is null.
 * `componentsSeen`, `haSeen`, `eventNames` and `slotByEventId` survive a disconnect: they
 * are log baselines, a name memory and the running slot assignments, reset only with the
 * whole object on a host or port change (`eventNames` is also pruned whenever the event
 * choices are rebuilt). While the WebSocket is down every entry of `slotEvents` is empty,
 * so the slot variables read blank, and the assignments wait for the first frame after
 * reconnect: an event still running then keeps its slot.
 *
 * @typedef {Object} BreakTimeData
 * @property {import('./api').BreakTimeEvent[]} events - `Playlist.Events` from the last frame, in playlist order
 * @property {import('./api').BreakTimeEvent|undefined} selectedEvent - The armed event: the playlist's own entry
 *   whose `ID` matches `NextEvent.ID`, or undefined when nothing (or a deleted event) is armed
 * @property {import('./api').BreakTimeEvent[]} running - Running events (`Status` 1), newest first by `StartMS`,
 *   ties in playlist order; `running[0]` is the latest
 * @property {number|''} runningEventsCount - Number of running events; '' while the WebSocket is down
 * @property {Map<string, number>} slotByEventId - Fixed running slot (1..runningSlots) of each running event that
 *   holds one, keyed by event ID; an event keeps its slot until it stops running (`assignRunningSlots()` in api.js)
 * @property {Array<import('./api').BreakTimeEvent|undefined>} slotEvents - The running event in each slot (index 0
 *   is slot 1), undefined for an empty slot; one entry per configured slot, refilled in place on every frame
 * @property {ConnectivityBucket} scte104Status - SCTE 104 bucket: Connected when the Client or the Server is
 *   Healthy, Disabled when both are Disabled
 * @property {ConnectivityBucket} vmixStatus - vMix bucket: Healthy is Connected, Disabled is Disabled, anything
 *   else Disconnected
 * @property {Object<string, ComponentState>} components - Status of every known component, keyed by slug
 *   (see COMPONENTS)
 * @property {Object<string, ComponentStatusName>} componentsSeen - Last component status seen in a frame, keyed
 *   by slug; the `state: component changed` baseline
 * @property {Object|null} ha - The frame's `HA` object as received (its enum values are strings), or null while
 *   the WebSocket is down
 * @property {HaSeen|null} haSeen - HA values from the last frame; the `state: ha changed` baseline, null before
 *   the first frame
 * @property {string|null} haRoleAlarm - The frame's `HARoleAlarm`, or null when none (and while the WebSocket is down)
 * @property {Map<string, string>} eventNames - Name of every event in the playlist, plus every removed event an
 *   `eventTile` still shows, so a removed event's tile can still name it; pruned to those when the event choices
 *   are rebuilt
 * @property {string} warningText - Text of the active timed warning, '' when none; `message` shows it while the
 *   warning is active
 * @property {boolean} temporaryWarning - True while a timed warning is active
 * @property {string|undefined} temporaryWarningType - Warning type ID of the active warning
 * @property {string|number} scte104SpliceEventID - Splice event ID of `LastStartedEvent` (Splice Insert only);
 *   '' for none or 0
 * @property {string|number} scte104SegmentationEventID - Segmentation event ID of `LastStartedEvent`
 *   (Time Signal only); '' for none or 0
 * @property {string} breaktimeVersion - Raw `GET /api/version` string (including `+sha`), '' until known
 * @property {''|'On'|'Off'} breaktimeSecurity - BreakTime security state, '' until known
 */

/**
 * Connectivity bucket shown by the legacy SCTE 104 and vMix variables and feedbacks
 * @typedef {'Connected'|'Disconnected'|'Disabled'|'Unknown'} ConnectivityBucket
 */

/**
 * Component status name; BreakTime's `Status` 0-3 by name, or Unknown when the key is missing or the WebSocket is down
 * @typedef {'Disabled'|'Unhealthy'|'Warning'|'Healthy'|'Unknown'} ComponentStatusName
 */

/**
 * One component's status as shown by the `component_<slug>` variables
 * @typedef {Object} ComponentState
 * @property {ComponentStatusName} status - Status name
 * @property {string} detail - BreakTime's `StatusDetail`, '' when unknown
 */

/**
 * HA values the `state: ha changed` line compares between frames
 * @typedef {Object} HaSeen
 * @property {string|undefined} role - `HA.Role`
 * @property {boolean|undefined} acting - `HA.Acting`
 * @property {string|undefined} link - `HA.LinkState`
 * @property {string|null} alarm - `HARoleAlarm`
 */

/**
 * Button colors shared by the feedback styles and the presets
 *
 * Tally meaning: red on air (or a fault), amber armed and ready, dark gray idle, green
 * connected (or the current value), gray not allowed now, muted gray with dimmed text for
 * an event no longer in the playlist.
 *
 * @type {Readonly<Object<string, number>>}
 */
const COLORS = Object.freeze({
	/** White text */
	WHITE: combineRgb(255, 255, 255),

	/** Black background or text */
	BLACK: combineRgb(0, 0, 0),

	/** Red background: on air, or a fault */
	RED: combineRgb(255, 0, 0),

	/** Green background: connected, or the current value */
	GREEN: combineRgb(0, 255, 0),

	/** Gray background: an action that is not allowed now */
	GRAY: combineRgb(125, 125, 125),

	/** Muted gray background: an event no longer in the playlist; dark enough for DIM_TEXT to stay readable */
	REMOVED_GRAY: combineRgb(64, 64, 64),

	/** Amber background: armed and ready */
	AMBER: combineRgb(255, 160, 0),

	/** Dark gray background: idle */
	DARK_GRAY: combineRgb(40, 40, 40),

	/** Dimmed text on a dark background */
	DIM_TEXT: combineRgb(150, 150, 150),
})

/**
 * BreakTime component keys (`ComponentStatuses`) and the slugs used in variable IDs and options
 * @type {ReadonlyArray<{key: string, slug: string}>}
 */
const COMPONENTS = Object.freeze([
	Object.freeze({ key: 'Stream Injector', slug: 'stream_injector' }),
	Object.freeze({ key: 'SDI Injector', slug: 'sdi_injector' }),
	Object.freeze({ key: 'SCTE 104 Client', slug: 'scte104_client' }),
	Object.freeze({ key: 'SCTE 104 Server', slug: 'scte104_server' }),
	Object.freeze({ key: 'Captions', slug: 'captions' }),
	Object.freeze({ key: 'Zixi', slug: 'zixi' }),
	Object.freeze({ key: 'vMix', slug: 'vmix' }),
	Object.freeze({ key: 'AvailX TX', slug: 'availx_tx' }),
	Object.freeze({ key: 'Stream Health', slug: 'stream_health' }),
])

/**
 * Zero-width space (U+200B), written as an escape so it stays visible in the source
 *
 * `literalButtonText()` puts it inside `$(` and a backslash escape so Companion shows them as
 * typed. Never type the raw character here: it is invisible in an editor and a diff.
 * @type {string}
 */
const ZERO_WIDTH_SPACE = '\u200B'

/**
 * On-air frame for the Operator Panel START, as base64 PNG data with no `data:` prefix
 *
 * The image: 288 x 288 px, 8-bit RGBA (PNG color type 6), a 12 px opaque red border (255, 0, 0, the same as
 * COLORS.RED) on all four sides, every pixel inside the border fully transparent. Generated by a scratch Node
 * script, `gen-onair-frame.js` (zlib plus a local CRC32; IHDR, one IDAT with filter type 0 on every row, IEND),
 * never edited by hand.
 *
 * How Companion 5.1 draws a feedback `png64`, read from the installed 5.1.0 build (sources embedded in
 * `resources/main.js.map` and `resources/RenderThread.js.map`):
 * - `Instance/Connection/PresetsLegacy.ts` converts the preset with `ConvertLegacyStyleToElements()`
 *   (`Resources/ConvertLegacyStyleToElements.ts`). The button gets three layers in this order: background box,
 *   image, text. A feedback's `png64` and `pngalignment` become overrides of the image layer only, so the frame
 *   is drawn over the background color and under the text, and other feedbacks' colors still apply.
 * - The image layer covers the whole content area (x and y 0, width and height 100) with `fillMode: 'fit'`, and
 *   `drawBase64Image()` (`shared-lib/lib/Graphics/ImageBase.ts`) scales the image evenly, up or down, to fit that
 *   area and places it by `pngalignment`. It is never drawn at its native size.
 * - `Graphics/Renderer.ts` renders each key at the surface's size times an oversampling factor
 *   (`computeOversampling()`: 4 up to 96 px, 2 up to 168 px, 1 above), then scales the result down to the key.
 *
 * Why 288 px with a 12 px border: 288 is the drawing size of both a 72 px key (x4) and a 144 px preview (x2), so
 * at those sizes the image is drawn 1:1 with no resampling blur. The border scales with the key: 3 px at 72 (as
 * wide as Companion's own pushed-button border), 4 px at 96, 5 px at 120, 6 px at 144, the same on every side.
 * With the top bar shown (Companion 5.1's default decoration) the area under the bar is wider than it is tall, so
 * the frame is drawn as a square centered under the bar instead of around the whole key.
 *
 * @type {string}
 */
const ON_AIR_FRAME_PNG64 =
	'iVBORw0KGgoAAAANSUhEUgAAASAAAAEgCAYAAAAUg66AAAADYUlEQVR42u3UwQkAMAwDMe+/dDpBoY+UEJDAC/hxqaTMzCYWJ5iZAJmZAJmZCZCZCZCZmQCZmQCZmQmQmQmQmZkAmZkAmZl9C1AALgQIECBAgAQIECBAgAQIECBAgAQIECBAgAQIECBAgAQIECBAgAQIECBAgAAECBAgQIAECBAgQIAECBAgQIAECBAgQIAECBAgQIAECBAgQIAECBAgQIAABAgQIAABAgQIECABAgQIECABAgQIECABAgQIECABAgQIECABAgQIECABAgQIECAAAQIECBAgAQIECBAgAQIECBAgAQIECBAgAQIECBAgAQIECBAgAQIECBAgAAECBAhAgAABAgRIgAABAgRIgAABAgRIgAABAgRIgAABAgRIgAABAgRIgAABAgQIQIAAAQIESIAAAQIESIAAAQIESIAAAQIESIAAAQIESIAAAQIESIAAAQIECECAAAECECBAgAABEiBAgAABEiBAgAABEiBAgAABEiBAgAABEiBAgAABEiBAgAABAhAgQIAAARIgQIAAARIgQIAAARIgQIAAARIgQIAAARIgQIAAARIgQIAAAXIxIECAAAEIECBAgAAJECBAgAAJECBAgAAJECBAgAAJECBAgAAJECBAgAAJECBAgAABCBAgQAACBAgQIEACBAgQIEACBAgQIEACBAgQIEACBAgQIEACBAgQIEACBAgQIEAAAgQIECBAAgQIECBAAgQIECBAAgQIECBAAgQIECBAAgQIECBAAgQIECBAAAIECBCAAAECBAiQAAECBAiQAAECBAiQAAECBAiQAAECBAiQAAECBAiQAAECBAgQgAABAgQIkAABAgQIkAABAgQIkAABAgQIkAABAgQIkAABAgQIkAABAgQIEIAAAQIEIECAAAECJECAAAECJECAAAECJECAAAECJECAAAECJECAAAECJECAAAECBCBAgAABAiRAgAABAiRAgAABAiRAgAABAiRAgAABAiRAgAABAiRAgAABAgQgQIAAAQgQIECAAAkQIECAAAkQIECAAAkQIECAAAkQIECAAAkQIECAAAkQIECAAAEIECBAAAIECBAgQAIECBAgQAIE7A2QmVnXBMjMBMjMBMjMTIDMTIDMzATIzATIzEyAzEyAzMwEyMwEyMzseQePGx6KDnIMrwAAAABJRU5ErkJggg=='

module.exports = {
	/** Gap after a failed attempt before the next one, in ms (fixed, no backoff) */
	RECONNECT_MS: 5000,

	/** Longest silence between state frames before the socket is treated as lost, in ms */
	WATCHDOG_MS: 5000,

	/** WebSocket opening handshake timeout, in ms */
	HANDSHAKE_TIMEOUT_MS: 5000,

	/** REST request timeout, in ms; below Companion's 5 s action IPC timeout */
	REST_TIMEOUT_MS: 4000,

	/** Interval between re-checks while a pre-2.0 BreakTime is detected, in ms */
	VERSION_RECHECK_MS: 60000,

	/** Display time of a warning raised by a local guard, in ms */
	WARNING_LOCAL_MS: 2000,

	/** Display time of every other warning, in ms */
	WARNING_MS: 5000,

	/** Maximum length of a `detail=` log value, in characters (Unicode code points) */
	LOG_DETAIL_MAX: 200,

	/**
	 * Valid port text, as a `/.../` string for the config form's `regex`: 1 to 65535, with
	 * optional leading zeros
	 *
	 * Base's `Regex.PORT` stops at 65534 and refuses leading zeros. index.js checks the
	 * stored port with this same pattern, so the form and the module accept exactly the same
	 * values. Leading zeros stay valid because the module has always connected with them
	 * (1.x had no port check), so a zero-padded port saved by 1.x keeps working.
	 */
	PORT_REGEX: '/^0*([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/',

	/** Default number of running-event variable slots */
	DEFAULT_RUNNING_SLOTS: 4,

	/** Maximum number of running-event variable slots */
	MAX_RUNNING_SLOTS: 32,

	/** Shortest event duration BreakTime accepts, in seconds (its clamp floor) */
	DURATION_MIN_S: 6,

	/** Longest Splice Insert (`MessageMode` 0) duration BreakTime accepts, in seconds */
	DURATION_MAX_SPLICE_S: 6553,

	/** Longest Time Signal (`MessageMode` 1) duration BreakTime accepts, in seconds */
	DURATION_MAX_TIME_SIGNAL_S: 65535,

	/** Largest amount Armed Duration + / - accepts, in seconds */
	DURATION_STEP_MAX_S: 65535,

	/** How long a Set Armed Duration target is held while no frame shows it yet, in ms */
	PENDING_DURATION_MS: 2000,

	/**
	 * How long after a Start (or End) press that sent a request a further Start (or End) press is ignored, in ms
	 *
	 * Start and End each have their own window; arm and duration actions are not debounced.
	 */
	PRESS_DEBOUNCE_MS: 500,

	/** Button colors shared by the feedback styles and the presets */
	COLORS: COLORS,

	/** Thin red frame the Operator Panel START shows while any event is on air (base64 PNG) */
	ON_AIR_FRAME_PNG64: ON_AIR_FRAME_PNG64,

	/**
	 * Event choices shown before the first state frame arrives; copied, never assigned directly
	 * @type {ReadonlyArray<{id: string, label: string}>}
	 */
	CHOICES_EVENTS_PLACEHOLDER: Object.freeze([Object.freeze({ id: '0', label: 'Loading Events...' })]),

	/** Duration mode choices; IDs are the BreakTime `DurationMode` values as strings */
	CHOICES_DURATION_MODES: [
		{ id: '1', label: 'Count Up' },
		{ id: '0', label: 'Count Down' },
	],

	/**
	 * The Start Event dropdown entry that targets whatever event is armed
	 * @type {Readonly<{id: string, label: string}>}
	 */
	CHOICE_ARMED_EVENT: Object.freeze({ id: 'armed', label: 'Armed event (as shown in Companion)' }),

	/** End Running Event targets */
	CHOICES_END_TARGETS: [
		{ id: 'latest', label: 'Latest running' },
		{ id: 'all', label: 'All running' },
		{ id: 'specific', label: 'Specific event' },
	],

	/** Warning types for the `temporaryWarning` feedback */
	CHOICES_WARNINGS: [
		{ id: 'event', label: 'Event Related' },
		{ id: 'increaseDuration', label: 'Increase Duration Not Allowed' },
		{ id: 'decreaseDuration', label: 'Decrease Duration Not Allowed' },
		{ id: 'scte104', label: 'SCTE 104 Disconnected' },
		{ id: 'vmix', label: 'vMix Disconnected' },
		{ id: 'ack', label: 'Action Problem' },
		{ id: 'auth', label: 'Authentication' },
		{ id: 'version', label: 'Unsupported BreakTime Version' },
		{ id: 'connection', label: 'Request Failed' },
		{ id: 'ha', label: 'Sent to HA Standby' },
		{ id: 'global', label: 'BreakTime Warning' },
	],

	/** The `temporaryWarning` choice that matches a warning of any type; a feedback option only, never a warning type */
	CHOICE_ANY_WARNING: Object.freeze({ id: 'any', label: 'Any warning' }),

	/** BreakTime component keys and slugs, in display order */
	COMPONENTS: COMPONENTS,

	/** Component choices for the `componentStatus` feedback, by slug */
	CHOICES_COMPONENTS: COMPONENTS.map((component) => ({ id: component.slug, label: component.key })),

	/**
	 * Component status names indexed by BreakTime's `Status` value (0 Disabled, 1 Unhealthy, 2 Warning, 3 Healthy)
	 * @type {ReadonlyArray<ComponentStatusName>}
	 */
	COMPONENT_STATUS_NAMES: Object.freeze(['Disabled', 'Unhealthy', 'Warning', 'Healthy']),

	/** Component status choices for the `componentStatus` feedback */
	CHOICES_COMPONENT_STATUSES: [
		{ id: 'Healthy', label: 'Healthy' },
		{ id: 'Warning', label: 'Warning' },
		{ id: 'Unhealthy', label: 'Unhealthy' },
		{ id: 'Disabled', label: 'Disabled' },
		{ id: 'Unknown', label: 'Unknown' },
	],

	/** HA link state choices for the `haLinkState` feedback; BreakTime's `HA.LinkState` names */
	CHOICES_LINK_STATES: [
		{ id: 'Inactive', label: 'Inactive (standalone)' },
		{ id: 'Connecting', label: 'Connecting' },
		{ id: 'Connected', label: 'Connected' },
		{ id: 'Degraded', label: 'Degraded' },
	],

	/** Event targets for the `eventIsRunning` feedback */
	CHOICES_RUNNING_TARGETS: [
		{ id: 'any', label: 'Any event' },
		{ id: 'armed', label: 'Armed event' },
		{ id: 'specific', label: 'Specific event' },
	],

	/**
	 * Formats whole seconds as `m:ss` (minutes are not capped at 59)
	 *
	 * Used for the `eventTile` text and the Operator Panel duration labels. Example: 90
	 * gives `1:30`; 3725 gives `62:05`. A negative input gives `0:00`.
	 *
	 * @param {number} seconds - Seconds
	 * @returns {string} `m:ss`, or '' for a non-finite input
	 */
	formatClock(seconds) {
		const total = Math.max(0, Math.floor(Number(seconds)))

		if (!Number.isFinite(total)) {
			return ''
		}

		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
	},

	/**
	 * Returns text that Companion shows as typed on a button
	 *
	 * Companion 4.1 and 5.1 have no escape for button text: they replace each
	 * `$(connection:variable)` with that variable's value, and turn a literal backslash
	 * followed by `n`, `r` or `t` into a line break or a tab. A zero-width space
	 * (U+200B) after each `$` that comes before `(`, and after each backslash that comes
	 * before `n`, `r` or `t`, stops both without a visible change. For text the
	 * module puts on a button only: variable values and log text keep the original.
	 *
	 * Hot path (every tile on every frame): text with no `$` and no backslash is returned
	 * unchanged without a regex pass.
	 *
	 * @param {string} text - Text to show as typed, for example an event name
	 * @returns {string} The text, with those sequences broken by a zero-width space
	 */
	literalButtonText(text) {
		if (typeof text !== 'string' || (!text.includes('$') && !text.includes('\\'))) {
			return text
		}

		// '$$' in a replacement string inserts one '$'
		return text.replace(/\$(?=\()/g, '$$' + ZERO_WIDTH_SPACE).replace(/\\(?=[nrt])/g, '\\' + ZERO_WIDTH_SPACE)
	},

	/**
	 * Returns a new, independent BreakTime state object
	 *
	 * Replaces the old shared `DATA` object, which `Object.assign` copied by reference,
	 * so a "reset" reused the already-mutated object.
	 *
	 * @returns {BreakTimeData} Fresh state with nothing armed, nothing running and connectivity unknown
	 */
	createDefaultData() {
		const components = {}

		for (const component of COMPONENTS) {
			components[component.slug] = { status: 'Unknown', detail: '' }
		}

		return {
			events: [],
			selectedEvent: undefined,
			running: [],
			runningEventsCount: '',
			slotByEventId: new Map(),
			slotEvents: [],
			scte104Status: 'Unknown',
			vmixStatus: 'Unknown',
			components: components,
			componentsSeen: {},
			ha: null,
			haSeen: null,
			haRoleAlarm: null,
			eventNames: new Map(),
			warningText: '',
			temporaryWarning: false,
			temporaryWarningType: undefined,
			scte104SpliceEventID: '',
			scte104SegmentationEventID: '',
			breaktimeVersion: '',
			breaktimeSecurity: '',
		}
	},
}
