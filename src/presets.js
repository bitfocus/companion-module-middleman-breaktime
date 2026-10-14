/**
 * @fileoverview Preset definitions for the BreakTime module
 *
 * Categories: Event Controls, Duration Controls, Running (one preset per configured
 * running slot), Info/Variables, and the Operator Panel: a button panel for an operator
 * who picks the event (one tile per playlist event), picks its duration, then presses
 * START and END. Tally colors: red on air, amber armed and ready, dark gray idle.
 *
 * `initPresets()` runs at init, whenever the event list changes (the event tiles are per
 * event) and when the running slot count changes. Every preset action carries its
 * options explicitly.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

const { COLORS, ON_AIR_FRAME_PNG64, formatClock, literalButtonText } = require('./defaults')

/** Operator Panel duration buttons, in seconds */
const OPERATOR_DURATIONS = [30, 60, 90, 120, 180]

/** Operator Panel category name */
const CATEGORY_OPERATOR = 'Operator Panel'

/**
 * Button text naming the latest running event and its time on two lines: the event End `latest` ends
 * Example: renders as 'Event 2' over '00:42'
 */
const LATEST_RUNNING_TEXT = '$(breaktime:running_latest_name)\\n$(breaktime:running_latest_time_mmss)'

/**
 * Returns a button style with white text on black
 *
 * @private
 * @param {string} text - Button text; may contain variables
 * @param {string} [size='14'] - Text size
 * @returns {import('@companion-module/base').CompanionButtonStyleProps} Style
 */
function buttonStyle(text, size = '14') {
	return {
		text: text,
		size: size,
		color: COLORS.WHITE,
		bgcolor: COLORS.BLACK,
	}
}

/**
 * Returns a button preset whose press runs one action
 *
 * @private
 * @param {string} category - Preset category
 * @param {string} name - Preset name
 * @param {import('@companion-module/base').CompanionButtonStyleProps} style - Button style
 * @param {string|null} actionId - Action run on press, or null for a display-only button
 * @param {Object<string, *>} options - Action options
 * @param {import('@companion-module/base').CompanionPresetFeedback[]} feedbacks - Feedbacks
 * @returns {import('@companion-module/base').CompanionButtonPresetDefinition} Preset
 */
function buttonPreset(category, name, style, actionId, options, feedbacks) {
	return {
		type: 'button',
		category: category,
		name: name,
		style: style,
		steps: actionId ? [{ down: [{ actionId: actionId, options: options }], up: [] }] : [],
		feedbacks: feedbacks,
	}
}

module.exports = {
	/**
	 * Registers every preset with Companion
	 *
	 * Expensive: called at init, when the event list changes and when the running slot
	 * count changes, never per frame.
	 *
	 * @returns {void}
	 */
	initPresets: function () {
		let self = this

		const presets = {}
		const firstEventId = self.CHOICES_EVENTS[0]?.id ?? ''

		// Event Controls
		presets['Start'] = buttonPreset(
			'Event Controls',
			'Start Event',
			buttonStyle('Start', '18'),
			'startSelected',
			{ event: self.CHOICE_ARMED_EVENT.id, immediate: false, onlyWhenIdle: false },
			[],
		)

		presets['StartArmed'] = buttonPreset(
			'Event Controls',
			'Start Armed Event',
			buttonStyle('Start\\nArmed', '18'),
			'startArmed',
			{ immediate: false },
			[],
		)

		presets['End'] = buttonPreset(
			'Event Controls',
			'End Running Event',
			buttonStyle('End', '18'),
			'endSelected',
			{ target: 'latest', event: firstEventId, immediate: false },
			[],
		)

		presets['EndRunning'] = buttonPreset(
			'Event Controls',
			'End Running (Red While On Air)',
			buttonStyle('End\\nRunning'),
			'endSelected',
			{ target: 'latest', event: firstEventId, immediate: false },
			[
				{
					feedbackId: 'eventIsRunning',
					options: { target: 'any', event: firstEventId },
					style: {
						bgcolor: COLORS.RED,
						color: COLORS.WHITE,
						size: 'auto',
						text: `End\\n${LATEST_RUNNING_TEXT}`,
					},
				},
			],
		)

		presets['EndRunningImmediate'] = buttonPreset(
			'Event Controls',
			'End Running (Immediate)',
			buttonStyle('End\\nNow'),
			'endSelected',
			{ target: 'latest', event: firstEventId, immediate: true },
			[
				{
					feedbackId: 'eventIsRunning',
					options: { target: 'any', event: firstEventId },
					style: {
						bgcolor: COLORS.RED,
						color: COLORS.WHITE,
						size: 'auto',
						text: `End Now\\n${LATEST_RUNNING_TEXT}`,
					},
				},
			],
		)

		presets['Next'] = buttonPreset(
			'Event Controls',
			'Arm Next',
			buttonStyle('Next', '18'),
			'selectNextEvent',
			{},
			[],
		)

		presets['Previous'] = buttonPreset(
			'Event Controls',
			'Arm Previous',
			buttonStyle('Previous', '18'),
			'selectPreviousEvent',
			{},
			[],
		)

		// Duration Controls
		presets['Increase'] = buttonPreset(
			'Duration Controls',
			'Armed Duration +5s',
			buttonStyle('+5s', '18'),
			'increaseDuration',
			{ duration: '5' },
			[
				{
					feedbackId: 'IncDecNotAllowed',
					options: {},
					style: { bgcolor: COLORS.GRAY },
				},
				{
					feedbackId: 'temporaryWarning',
					options: { warning: 'increaseDuration' },
					style: { bgcolor: COLORS.RED },
				},
			],
		)

		presets['Decrease'] = buttonPreset(
			'Duration Controls',
			'Armed Duration -5s',
			buttonStyle('-5s', '18'),
			'decreaseDuration',
			{ duration: '5' },
			[
				{
					feedbackId: 'IncDecNotAllowed',
					options: {},
					style: { bgcolor: COLORS.GRAY },
				},
				{
					feedbackId: 'temporaryWarning',
					options: { warning: 'decreaseDuration' },
					style: { bgcolor: COLORS.RED },
				},
			],
		)

		// Running
		for (let slot = 1; slot <= self.getRunningSlotCount(); slot++) {
			presets[`RunningSlot${slot}`] = buttonPreset(
				'Running',
				`Running Slot ${slot}`,
				buttonStyle(`$(breaktime:running_${slot}_name)\\n$(breaktime:running_${slot}_time_mmss)`, 'auto'),
				null,
				{},
				[
					{
						feedbackId: 'runningRemainingBelow',
						options: { slot: String(slot), seconds: '10' },
						style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
					},
				],
			)
		}

		presets['RunningStatus'] = buttonPreset(
			'Running',
			'Running Status',
			buttonStyle('Running\\n$(breaktime:running_events_count)'),
			null,
			{},
			[
				{
					feedbackId: 'eventIsRunning',
					options: { target: 'any', event: firstEventId },
					style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
				},
			],
		)

		// Info/Variables
		presets['RunningEventsCount'] = buttonPreset(
			'Info/Variables',
			'Running Events Count',
			buttonStyle('$(breaktime:running_events_count)'),
			null,
			{},
			[],
		)

		presets['SelectedName'] = buttonPreset(
			'Info/Variables',
			'Armed Event Name',
			buttonStyle('$(breaktime:selected_name)', 'auto'),
			null,
			{},
			[],
		)

		// The 1.0.3 red "finished" entry is not revived (lead decision): it never fired
		presets['SelectedStatus'] = buttonPreset(
			'Info/Variables',
			'Armed Event Status',
			buttonStyle('$(breaktime:selected_status)'),
			null,
			{},
			[
				{
					feedbackId: 'selectedIsRunning',
					options: {},
					style: { bgcolor: COLORS.GREEN },
				},
			],
		)

		presets['SelectedDuration'] = buttonPreset(
			'Info/Variables',
			'Armed Event Duration',
			buttonStyle('$(breaktime:selected_duration_hhmmss)'),
			null,
			{},
			[],
		)

		presets['SelectedTime'] = buttonPreset(
			'Info/Variables',
			'Armed Event Time Remaining/Elapsed',
			buttonStyle('$(breaktime:selected_time_hhmmss)'),
			null,
			{},
			[],
		)

		presets['SelectedDurationMode'] = buttonPreset(
			'Info/Variables',
			'Armed Event Duration Mode',
			buttonStyle('$(breaktime:selected_duration_mode)'),
			null,
			{},
			[
				{
					feedbackId: 'selectedDurationMode',
					options: { mode: '0' },
					style: { bgcolor: COLORS.GREEN },
				},
				{
					feedbackId: 'selectedDurationMode',
					options: { mode: '1' },
					style: { bgcolor: COLORS.RED },
				},
			],
		)

		const scte104Feedbacks = [
			{
				feedbackId: 'scte104Connected',
				options: {},
				style: { bgcolor: COLORS.GREEN },
			},
			{
				feedbackId: 'scte104Disconnected',
				options: {},
				style: { bgcolor: COLORS.RED },
			},
		]

		const vmixFeedbacks = [
			{
				feedbackId: 'vMixConnected',
				options: {},
				style: { bgcolor: COLORS.GREEN },
			},
			{
				feedbackId: 'vMixDisconnected',
				options: {},
				style: { bgcolor: COLORS.RED },
			},
		]

		presets['Scte104InjectorStatusBool'] = buttonPreset(
			'Info/Variables',
			'SCTE 104 Injector Connected (True/False)',
			buttonStyle('SCTE 104: $(breaktime:scte104_injector_status_bool)'),
			null,
			{},
			scte104Feedbacks,
		)

		presets['Scte104InjectorStatus'] = buttonPreset(
			'Info/Variables',
			'SCTE 104 Injector Status',
			buttonStyle('SCTE 104: $(breaktime:scte104_injector_status)'),
			null,
			{},
			scte104Feedbacks,
		)

		presets['VmixStatusBool'] = buttonPreset(
			'Info/Variables',
			'vMix Connected (True/False)',
			buttonStyle('vMix: $(breaktime:vmix_status_bool)'),
			null,
			{},
			vmixFeedbacks,
		)

		presets['VmixStatus'] = buttonPreset(
			'Info/Variables',
			'vMix Connectivity Status',
			buttonStyle('vMix: $(breaktime:vmix_status)'),
			null,
			{},
			vmixFeedbacks,
		)

		presets['Message'] = buttonPreset(
			'Info/Variables',
			'Current Message',
			buttonStyle('$(breaktime:message)', 'auto'),
			null,
			{},
			[],
		)

		self.addOperatorPanelPresets(presets, firstEventId)

		self.setPresetDefinitions(presets)
	},

	/**
	 * Adds the Operator Panel presets: event tiles, duration buttons, START, END, END ALL and the panel status
	 *
	 * - Event tiles: one per playlist event (from CHOICES_EVENTS, never the placeholder).
	 *   Press arms that event; the `eventTile` feedback shows its name, duration and live
	 *   time, amber when armed and red while on air. The tile's own text is the name as
	 *   typed (`literalButtonText()`), the same as the feedback. A tile stores the event ID: JSON
	 *   imports keep IDs, XLS imports create new ones.
	 * - Duration buttons: press sets the armed duration; green when it is the current
	 *   duration, dimmed when the duration cannot change.
	 * - START names exactly what it fires and starts the armed event (a second press within
	 *   PRESS_DEBOUNCE_MS is ignored). Its text never changes. Amber when the armed event is
	 *   stopped, dimmed when the armed event is itself on air (`startSelected()` refuses it
	 *   locally), and a thin red frame (ON_AIR_FRAME_PNG64) while any event runs. The frame
	 *   entry comes first and sets only the image, so the colors of the entries after it apply.
	 * - END is blank on black while idle and red with the latest running event while one
	 *   runs; END ALL shows only while two or more run.
	 * - Panel status shows `message`: amber during any warning, red `STANDBY` on a paired
	 *   standby node.
	 *
	 * @private
	 * @param {Object<string, import('@companion-module/base').CompanionPresetDefinition>} presets - Preset set to fill
	 * @param {string} firstEventId - First event ID, '' for an empty playlist
	 * @returns {void}
	 */
	addOperatorPanelPresets: function (presets, firstEventId) {
		let self = this

		for (const choice of self.CHOICES_EVENTS) {
			if (choice.id === self.CHOICES_EVENTS_PLACEHOLDER[0].id) {
				continue
			}

			presets[`OperatorBreak_${choice.id}`] = buttonPreset(
				CATEGORY_OPERATOR,
				choice.label,
				{ ...buttonStyle(literalButtonText(choice.label), 'auto'), bgcolor: COLORS.DARK_GRAY },
				'selectEvent',
				{ event: choice.id },
				[
					{
						feedbackId: 'eventTile',
						options: { event: choice.id },
					},
				],
			)
		}

		for (const seconds of OPERATOR_DURATIONS) {
			const label = formatClock(seconds)

			presets[`OperatorDuration_${seconds}`] = buttonPreset(
				CATEGORY_OPERATOR,
				`Duration ${label}`,
				buttonStyle(label, '18'),
				'setArmedDuration',
				{ seconds: String(seconds) },
				[
					{
						feedbackId: 'armedDurationIs',
						options: { seconds: String(seconds) },
						style: { bgcolor: COLORS.GREEN, color: COLORS.BLACK },
					},
					{
						feedbackId: 'IncDecNotAllowed',
						options: {},
						style: { color: COLORS.DIM_TEXT },
					},
				],
			)
		}

		presets['OperatorStart'] = buttonPreset(
			CATEGORY_OPERATOR,
			'START',
			buttonStyle('START\\n$(breaktime:selected_name)\\n$(breaktime:selected_duration_mmss)', 'auto'),
			'startSelected',
			{ event: self.CHOICE_ARMED_EVENT.id, immediate: false, onlyWhenIdle: false },
			[
				{
					feedbackId: 'eventIsRunning',
					options: { target: 'any', event: firstEventId },
					style: { png64: ON_AIR_FRAME_PNG64, pngalignment: 'center:center' },
				},
				{
					feedbackId: 'selectedisFinished',
					options: {},
					style: { bgcolor: COLORS.AMBER, color: COLORS.BLACK },
				},
				{
					feedbackId: 'selectedIsRunning',
					options: {},
					style: { bgcolor: COLORS.DARK_GRAY, color: COLORS.DIM_TEXT },
				},
			],
		)

		presets['OperatorEnd'] = buttonPreset(
			CATEGORY_OPERATOR,
			'END',
			buttonStyle('', 'auto'),
			'endSelected',
			{ target: 'latest', event: firstEventId, immediate: false },
			[
				{
					feedbackId: 'eventIsRunning',
					options: { target: 'any', event: firstEventId },
					style: {
						bgcolor: COLORS.RED,
						color: COLORS.WHITE,
						text: `END\\n${LATEST_RUNNING_TEXT}`,
					},
				},
			],
		)

		presets['OperatorEndAll'] = buttonPreset(
			CATEGORY_OPERATOR,
			'END ALL',
			buttonStyle('', 'auto'),
			'endSelected',
			{ target: 'all', event: firstEventId, immediate: false },
			[
				{
					feedbackId: 'runningCountAtLeast',
					options: { count: 2 },
					style: {
						bgcolor: COLORS.RED,
						color: COLORS.WHITE,
						text: 'END ALL\\n$(breaktime:running_events_count) running',
					},
				},
			],
		)

		presets['OperatorStatus'] = buttonPreset(
			CATEGORY_OPERATOR,
			'Panel Status',
			buttonStyle('$(breaktime:message)', 'auto'),
			null,
			{},
			[
				{
					feedbackId: 'temporaryWarning',
					options: { warning: self.CHOICE_ANY_WARNING.id },
					style: { bgcolor: COLORS.AMBER, color: COLORS.BLACK },
				},
				{
					feedbackId: 'haStandby',
					options: {},
					style: { bgcolor: COLORS.RED, color: COLORS.WHITE, text: 'STANDBY\\n$(breaktime:message)' },
				},
			],
		)
	},
}
