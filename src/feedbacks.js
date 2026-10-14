/**
 * @fileoverview Feedback definitions for the BreakTime module
 *
 * Feedback callbacks read the cached state in `this.DATA`, which api.js refreshes from
 * each BreakTime state frame. `buildFeedbackState()` gives each feedback type a signature
 * of its inputs, so `checkVariables()` re-checks only the types whose inputs changed. The
 * `eventTile` feedback is checked per instance instead (`buildTileSignatures()`): each tile
 * names one event, so only the tiles whose event changed are re-checked and idle tiles
 * cost no Companion call per frame. A tile is tracked in `tileFeedbacks` only while its
 * event is in the playlist; any other tile goes in `unlistedTileFeedbacks`, which only
 * keeps a removed event's name remembered. `rebuildEventChoices()` in api.js moves the
 * tiles of removed events across and re-checks every tile.
 * Colors, `formatClock()` and `literalButtonText()` come from defaults.js, shared with the
 * presets.
 *
 * Stored feedback IDs are unchanged from 1.0.3; only the display names changed
 * ("Selected" is now "Armed", matching the BreakTime UI).
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

const { COLORS, formatClock, literalButtonText } = require('./defaults')

/**
 * What an `eventTile` shows for one event
 * @typedef {Object} TileView
 * @property {'running'|'armed'|'idle'|'removed'|'unknown'} state - Tile state; selects the colors
 * @property {string|undefined} text - Literal button text, or undefined to keep the button's own text
 */

/**
 * Style per `eventTile` state: red on air, amber armed, dark gray idle, muted gray with dimmed text for an event
 * no longer in the playlist, dimmed text while not connected
 * @type {Object<TileView['state'], {bgcolor: number, color: number}>}
 */
const TILE_STYLES = {
	running: { bgcolor: COLORS.RED, color: COLORS.WHITE },
	armed: { bgcolor: COLORS.AMBER, color: COLORS.BLACK },
	idle: { bgcolor: COLORS.DARK_GRAY, color: COLORS.WHITE },
	removed: { bgcolor: COLORS.REMOVED_GRAY, color: COLORS.DIM_TEXT },
	unknown: { bgcolor: COLORS.DARK_GRAY, color: COLORS.DIM_TEXT },
}

/**
 * Converts a variable-enabled option (already parsed by Companion) to an integer
 *
 * @private
 * @param {*} value - Option value: text, or a number from a stored button
 * @returns {number|null} The integer, or null when the value is blank or not a whole number
 */
function toInteger(value) {
	const number = typeof value === 'string' && value.trim() === '' ? NaN : Number(value)

	return Number.isInteger(number) ? number : null
}

module.exports = {
	/**
	 * Registers every feedback definition with Companion
	 *
	 * Expensive: call at init and only again when a definition or its choices change
	 * (the event list, see `processData`).
	 *
	 * @returns {void}
	 */
	initFeedbacks() {
		let self = this
		const feedbacks = {}

		const eventOption = {
			type: 'dropdown',
			label: 'Event',
			id: 'event',
			default: self.CHOICES_EVENTS[0]?.id ?? '',
			choices: self.CHOICES_EVENTS,
		}

		feedbacks.selectedIsRunning = {
			type: 'boolean',
			name: 'Armed Event is Running',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [],
			callback: async function () {
				return self.DATA.selectedEvent?.Status === 1
			},
		}

		feedbacks.selectedisFinished = {
			type: 'boolean',
			name: 'Armed Event is Stopped',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [],
			callback: async function () {
				return self.DATA.selectedEvent?.Status === 0
			},
		}

		feedbacks.selectedDurationMode = {
			type: 'boolean',
			name: 'Armed Event Duration Mode',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [
				{
					type: 'dropdown',
					label: 'Mode',
					id: 'mode',
					choices: self.CHOICES_DURATION_MODES,
					default: self.CHOICES_DURATION_MODES[0].id,
				},
			],
			callback: async function (feedback) {
				return (
					self.DATA.selectedEvent?.DurationMode ===
					Number(feedback.options.mode ?? self.CHOICES_DURATION_MODES[0].id)
				)
			},
		}

		feedbacks.IncDecNotAllowed = {
			type: 'boolean',
			name: 'Armed Duration Change Not Allowed',
			description:
				'When nothing is armed, the armed event counts up or is running, or Companion is not connected to BreakTime',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.GRAY,
			},
			options: [],
			callback: async function () {
				return self.getDurationBlock() !== ''
			},
		}

		feedbacks.armedDurationIs = {
			type: 'boolean',
			name: 'Armed Duration Is',
			description: 'Count Down events only',
			defaultStyle: {
				color: COLORS.BLACK,
				bgcolor: COLORS.GREEN,
			},
			options: [
				{
					type: 'textinput',
					label: 'Seconds',
					id: 'seconds',
					default: '60',
					useVariables: true,
				},
			],
			callback: async function (feedback) {
				const seconds = toInteger(feedback.options.seconds ?? '60')

				if (seconds === null || self.DATA.selectedEvent?.DurationMode !== 0) {
					return false
				}

				return self.getArmedDuration() === seconds
			},
		}

		feedbacks.eventIsRunning = {
			type: 'boolean',
			name: 'Event is Running',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					default: self.CHOICES_RUNNING_TARGETS[0].id,
					choices: self.CHOICES_RUNNING_TARGETS,
				},
				{
					...eventOption,
					isVisibleExpression: "$(options:target) == 'specific'",
				},
			],
			callback: async function (feedback) {
				const target = feedback.options.target

				if (target === 'armed') {
					return self.DATA.selectedEvent?.Status === 1
				}

				if (target === 'specific') {
					return self.DATA.running.some((event) => event.ID === feedback.options.event)
				}

				return self.DATA.running.length > 0
			},
		}

		feedbacks.runningRemainingBelow = {
			type: 'boolean',
			name: 'Running Slot Time Remaining Below',
			description: 'Count Down events only',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [
				{
					type: 'textinput',
					label: 'Slot',
					id: 'slot',
					default: '1',
					useVariables: true,
					tooltip: `1 to ${self.MAX_RUNNING_SLOTS}. An event keeps its slot until it ends.`,
				},
				{
					type: 'textinput',
					label: 'Seconds',
					id: 'seconds',
					default: '10',
					useVariables: true,
				},
			],
			callback: async function (feedback) {
				const slot = toInteger(feedback.options.slot ?? '1')
				const seconds = toInteger(feedback.options.seconds ?? '10')

				if (slot === null || slot < 1 || slot > self.MAX_RUNNING_SLOTS || seconds === null || seconds < 0) {
					return false
				}

				const event = self.DATA.slotEvents[slot - 1]

				return event?.DurationMode === 0 && event.RemainingSeconds < seconds
			},
		}

		feedbacks.runningCountAtLeast = {
			type: 'boolean',
			name: 'Running Event Count At Least',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [
				{
					type: 'number',
					label: 'Count',
					id: 'count',
					default: 2,
					min: 1,
					max: 1000,
				},
			],
			callback: async function (feedback) {
				const count = Number(feedback.options.count ?? 2)
				const running = self.DATA.running.length

				return Number.isFinite(count) && running > 0 && running >= count
			},
		}

		feedbacks.eventTile = {
			type: 'advanced',
			name: 'Event Tile',
			description: 'Shows one event: red on air with its time, amber when armed, dark gray when idle',
			options: [eventOption],
			callback: function (feedback) {
				const eventId = typeof feedback.options.event === 'string' ? feedback.options.event : ''

				// Remember which event this instance shows, so only its changes re-check it.
				// A tile for an event that is not in the playlist is not tracked per frame: it
				// shows "(removed)" until `rebuildEventChoices()` re-checks every tile. It is
				// kept in `unlistedTileFeedbacks` only so the removed event's name stays known.
				if (eventId !== '' && self.DATA.events.some((entry) => entry.ID === eventId)) {
					self.tileFeedbacks.set(feedback.id, eventId)
					self.unlistedTileFeedbacks.delete(feedback.id)
				} else if (eventId !== '') {
					self.tileFeedbacks.delete(feedback.id)
					self.unlistedTileFeedbacks.set(feedback.id, eventId)
				} else {
					self.tileFeedbacks.delete(feedback.id)
					self.unlistedTileFeedbacks.delete(feedback.id)
				}

				const view = self.getEventTileView(eventId)
				const style = { ...TILE_STYLES[view.state] }

				if (view.text !== undefined) {
					style.text = view.text
				}

				return style
			},
			unsubscribe: function (feedback) {
				self.tileFeedbacks.delete(feedback.id)
				self.unlistedTileFeedbacks.delete(feedback.id)
			},
		}

		feedbacks.vMixConnected = {
			type: 'boolean',
			name: 'vMix Connected',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.GREEN,
			},
			options: [],
			callback: async function () {
				return self.DATA.vmixStatus === 'Connected'
			},
		}

		feedbacks.vMixDisconnected = {
			type: 'boolean',
			name: 'vMix Disconnected',
			description: 'vMix is enabled in BreakTime but not connected',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [],
			callback: async function () {
				return self.DATA.vmixStatus === 'Disconnected'
			},
		}

		feedbacks.scte104Connected = {
			type: 'boolean',
			name: 'SCTE 104 Injector Connected',
			description: 'The SCTE 104 Client or Server is connected',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.GREEN,
			},
			options: [],
			callback: async function () {
				return self.DATA.scte104Status === 'Connected'
			},
		}

		feedbacks.scte104Disconnected = {
			type: 'boolean',
			name: 'SCTE 104 Injector Disconnected',
			description: 'SCTE 104 is enabled in BreakTime but neither the Client nor the Server is connected',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [],
			callback: async function () {
				return self.DATA.scte104Status === 'Disconnected'
			},
		}

		feedbacks.componentStatus = {
			type: 'boolean',
			name: 'Component Status',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [
				{
					type: 'dropdown',
					label: 'Component',
					id: 'component',
					default: self.CHOICES_COMPONENTS[0].id,
					choices: self.CHOICES_COMPONENTS,
				},
				{
					type: 'dropdown',
					label: 'Status',
					id: 'status',
					default: 'Unhealthy',
					choices: self.CHOICES_COMPONENT_STATUSES,
				},
			],
			callback: async function (feedback) {
				const component = self.DATA.components[feedback.options.component ?? self.CHOICES_COMPONENTS[0].id]

				return component?.status === (feedback.options.status ?? 'Unhealthy')
			},
		}

		feedbacks.haActing = {
			type: 'boolean',
			name: 'HA Live',
			description:
				'This instance is the live one. Also on for a BreakTime licensed as Primary that is not paired.',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.GREEN,
			},
			options: [],
			callback: async function () {
				return self.DATA.ha?.Acting === true
			},
		}

		feedbacks.haStandby = {
			type: 'boolean',
			name: 'HA Standby',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [],
			callback: async function () {
				return self.DATA.ha?.Paired === true && self.DATA.ha.Acting === false
			},
		}

		feedbacks.haLinkState = {
			type: 'boolean',
			name: 'HA Link State',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [
				{
					type: 'dropdown',
					label: 'State',
					id: 'state',
					default: 'Degraded',
					choices: self.CHOICES_LINK_STATES,
				},
			],
			callback: async function (feedback) {
				return self.DATA.ha?.LinkState === (feedback.options.state ?? 'Degraded')
			},
		}

		feedbacks.haEmitReady = {
			type: 'boolean',
			name: 'HA Ready to Send',
			description:
				'This instance is licensed, has an SCTE 35 PID set or the SDI Injector on, and has at least one output connected',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.GREEN,
			},
			options: [],
			callback: async function () {
				return self.DATA.ha?.EmitReady === true
			},
		}

		feedbacks.temporaryWarning = {
			type: 'boolean',
			name: 'Temporary Warning',
			description: 'Warnings show for 2 to 5 seconds',
			defaultStyle: {
				color: COLORS.WHITE,
				bgcolor: COLORS.RED,
			},
			options: [
				{
					type: 'dropdown',
					label: 'Warning Type',
					id: 'warning',
					choices: [...self.CHOICES_WARNINGS, self.CHOICE_ANY_WARNING],
					default: self.CHOICES_WARNINGS[0].id,
				},
			],
			callback: async function (feedback) {
				if (!self.DATA.temporaryWarning) {
					return false
				}

				const type = feedback.options.warning ?? self.CHOICES_WARNINGS[0].id

				return type === self.CHOICE_ANY_WARNING.id || self.DATA.temporaryWarningType === type
			},
		}

		self.setFeedbackDefinitions(feedbacks)
	},

	/**
	 * Returns what an `eventTile` shows for one event
	 *
	 * Literal text, no variables, lines separated by Companion's `\n` line-break sequence.
	 * The name goes through `literalButtonText()`, so a name containing `$(...)` or a
	 * literal backslash-n shows as typed, not as a variable's value or a line break.
	 * Running gives the name plus the remaining time (Count Down) or the elapsed time
	 * (Count Up) as `m:ss`; armed and idle give the name plus the duration (the armed
	 * event's pending Set Armed Duration target when one is held; no duration line at 0 s).
	 * An event no longer in the playlist gives its last known name plus `(removed)`. While
	 * not connected the tile shows only the event name (or keeps the button's own text when
	 * the event is unknown), dimmed.
	 *
	 * @param {string} eventId - Event ID from the tile's `event` option
	 * @returns {TileView} State and text
	 */
	getEventTileView(eventId) {
		let self = this

		const DATA = self.DATA
		const live = self.isLive()
		const event = eventId ? DATA.events.find((entry) => entry.ID === eventId) : undefined

		if (!event) {
			if (!live) {
				return { state: 'unknown', text: undefined }
			}

			const name = literalButtonText(DATA.eventNames.get(eventId))

			return { state: 'removed', text: name ? `${name}\\n(removed)` : '(removed)' }
		}

		const name = literalButtonText(event.Name ?? '')

		if (!live) {
			return { state: 'unknown', text: name }
		}

		if (event.Status === 1) {
			const seconds = event.DurationMode === 1 ? event.ElapsedSeconds : event.RemainingSeconds

			return { state: 'running', text: `${name}\\n${formatClock(seconds)}` }
		}

		const armed = DATA.selectedEvent?.ID === event.ID
		const duration = armed ? self.getArmedDuration() : event.DurationSeconds
		const text = duration > 0 ? `${name}\\n${formatClock(duration)}` : name

		return { state: armed ? 'armed' : 'idle', text: text }
	},

	/**
	 * Returns a signature per event shown by an `eventTile`, for per-instance change detection
	 *
	 * Hot path (every state frame). Only events that some tile shows are computed, once
	 * each. A signature is exactly what the tile would display (state and text), so it
	 * changes only when that event's name, status, armed state or displayed second
	 * changes. `checkVariables()` re-checks, by instance ID, only the tiles whose signature
	 * changed.
	 *
	 * @returns {Object<string, string>} Signature per event ID
	 */
	buildTileSignatures() {
		let self = this

		const signatures = {}

		for (const eventId of self.tileFeedbacks.values()) {
			if (signatures[eventId] === undefined) {
				const view = self.getEventTileView(eventId)

				signatures[eventId] = `${view.state}|${view.text ?? ''}`
			}
		}

		return signatures
	},

	/**
	 * Returns a signature of each feedback type's inputs, for change detection
	 *
	 * Hot path (every state frame). A type's signature must change whenever any of its
	 * callbacks could return something different, and should stay equal otherwise: then
	 * `checkVariables()` re-checks only the types whose signature changed. Signatures are
	 * primitives, compared with `!==`. Every feedback type except `eventTile` is listed
	 * (tiles are checked per instance, see `buildTileSignatures()`); a type missing here
	 * would only be re-checked on a full push.
	 *
	 * @returns {Object<string, string|number|boolean|undefined>} Signature per feedback type
	 */
	buildFeedbackState() {
		let self = this

		const DATA = self.DATA
		const armed = DATA.selectedEvent
		const ha = DATA.ha
		const warning = DATA.temporaryWarning ? DATA.temporaryWarningType : ''

		// Running IDs newest first ('' while nothing runs), and each fixed slot's event and remaining time
		let runningIds = ''
		let slotTimes = ''

		for (const event of DATA.running) {
			runningIds += `${event.ID},`
		}

		for (const event of DATA.slotEvents) {
			slotTimes += event ? `${event.ID}:${event.DurationMode}:${event.RemainingSeconds},` : ','
		}

		let components = ''

		for (const component of self.COMPONENTS) {
			components += `${DATA.components[component.slug].status},`
		}

		return {
			selectedIsRunning: armed?.Status,
			selectedisFinished: armed?.Status,
			selectedDurationMode: armed?.DurationMode,
			IncDecNotAllowed: self.getDurationBlock() !== '',
			armedDurationIs: `${armed?.DurationMode}|${self.getArmedDuration()}`,
			eventIsRunning: `${runningIds}|${armed?.Status}`,
			runningRemainingBelow: slotTimes,
			runningCountAtLeast: DATA.running.length,
			vMixConnected: DATA.vmixStatus,
			vMixDisconnected: DATA.vmixStatus,
			scte104Connected: DATA.scte104Status,
			scte104Disconnected: DATA.scte104Status,
			componentStatus: components,
			haActing: ha?.Acting,
			haStandby: ha?.Paired === true && ha.Acting === false,
			haLinkState: ha?.LinkState,
			haEmitReady: ha?.EmitReady,
			temporaryWarning: warning,
		}
	},
}
