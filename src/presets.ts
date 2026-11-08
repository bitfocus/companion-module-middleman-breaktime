/**
 * @fileoverview Preset definitions for the BreakTime module
 *
 * The presets are workflow-oriented building blocks the operator drops onto any surface and
 * arranges themselves — there is no fixed panel layout. One design system runs through every
 * block: one meaning per colour (dark gray idle, amber armed/ready, red running, green the
 * selected duration or a connected output, gray an action not allowed now, dimmed text when an
 * action is not allowed or a readout is stopped), an explicit pinned `size` per role so
 * same-role buttons match (`'auto'` only on the variable-length name and message lines), and a
 * static `png64` glyph per transport/arm/nudge block (drawn `center:top` with its word label
 * `center:bottom`). The status countdown tiles pin their own size, and their `countingDown` /
 * `remainingTimeBelow` boolean feedbacks recolour bgcolor and text only, so the tiles never resize.
 *
 * Four workflow categories (base 2.x preset sections):
 * - Simple Workflow (Fixed): a 0:30 to 3:00 Set Duration keypad, then START, END, END NOW and a
 *   status countdown tile. For a single event with a small set of fixed lengths.
 * - Simple Workflow (Variable): + / - duration nudges in place of the keypad, then the same
 *   START, END, END NOW and status countdown tile. For a single event trimmed on the fly.
 * - Playlist Workflow: a next-event readout, PREV / NEXT arm steppers, +/-5 s nudges, START (not
 *   idle-gated, so several events can run), END NOW, END ALL and a latest-running status tile.
 * - Info & Status: display-only readouts for the armed event, the running count, the status /
 *   message line and the SCTE 104 and vMix links.
 *
 * `initPresets()` runs at init, whenever the event list changes and when the running slot count
 * changes. Every preset is a `simple` preset, carries its action options explicitly, and is
 * listed by ID in a `CompanionPresetSection` so the categories appear in the Companion UI in the
 * order built here. Every glyph is a constant from defaults.ts, encoded once, so nothing is
 * drawn or re-encoded per frame. No preset sets a step action `delay`.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

import type {
	CompanionButtonStyleProps,
	CompanionOptionValues,
	CompanionPresetDefinitions,
	CompanionPresetOptionValues,
	CompanionPresetSection,
	CompanionSimplePresetDefinition,
	CompanionTextSize,
	SomePresetActionEntry,
	SomePresetSimpleFeedbackEntry,
	StringKeys,
} from '@companion-module/base'
import type { BreakTimeInstanceTypes } from './main.js'
import type BreakTimeInstance from './main.js'

import {
	COLORS,
	PLAY_PNG64,
	STOP_PNG64,
	BOLT_PNG64,
	STOP_ALL_PNG64,
	CHEVRON_RIGHT_PNG64,
	CHEVRON_LEFT_PNG64,
	PLUS_PNG64,
	MINUS_PNG64,
	CHOICE_ARMED_EVENT,
	formatClock,
} from './defaults.js'

/** Set Armed Duration keypad values, in seconds (0:30, 1:00, 1:30, 2:00, 3:00) */
const DURATION_PRESETS = [30, 60, 90, 120, 180]

/**
 * Pinned text size for the glyph blocks (transport, arm, nudge)
 * Single-word glyph labels, and the two-line END NOW / END ALL labels, fit the bottom band below
 * the glyph (glyphs occupy the top ~half of the 288 canvas, leaving the lower band clear).
 */
const SIZE_BLOCK: CompanionTextSize = '14'

/**
 * Pinned text size for the compact text-only readout lines: the SCTE 104 / vMix links, the
 * running count, the armed status and the armed duration/time clocks. '7' is the only fixed
 * Companion font size below '14' (the fixed point sizes are '7', '14', '18', '24', '30', '44'),
 * and it fits a "Disconnected" / "HH:MM:SS" value on one line. Pinned rather than 'auto' so the
 * text keeps one size across every state, the no-resize goal; 'auto' stays only on the genuinely
 * variable-length name and message lines (SIZE_LABEL).
 */
const SIZE_READOUT: CompanionTextSize = '7'

/** Pinned text size for the Set Armed Duration keypad (a single clock label, no glyph) */
const SIZE_DURATION: CompanionTextSize = '18'

/**
 * Pinned text size for the status countdown tiles (a single mm:ss clock, no glyph)
 *
 * Pinned so the `countingDown` and `remainingTimeBelow` boolean feedbacks — which only recolour
 * bgcolor and text — never resize the tile as it bands from green through amber to red.
 */
const SIZE_STATUS: CompanionTextSize = '18'

/** Size for the variable-length lines (event name, armed readouts, status message) where fitting the text matters */
const SIZE_LABEL: CompanionTextSize = 'auto'

/**
 * Returns a plain button style: white text on the dark-gray idle fill
 *
 * The idle fill is unified to dark gray across every block (the design system's single idle
 * colour). Callers override `bgcolor`/`color` for the non-idle states through feedbacks.
 *
 * @param text - Button text; may contain variables
 * @param size - Pinned text size
 * @returns Style
 */
function buttonStyle(text: string, size: CompanionTextSize = SIZE_BLOCK): CompanionButtonStyleProps {
	return {
		text: text,
		size: size,
		color: COLORS.WHITE,
		bgcolor: COLORS.DARK_GRAY,
	}
}

/**
 * Returns a status-tile base style: dimmed text on a black fill
 *
 * The base of a status countdown tile, shown while the tracked event is stopped or counting up (its
 * idle appearance). The `countingDown` and `remainingTimeBelow` boolean feedbacks layer over it,
 * recolouring the tile to green, then amber, then red as the time runs down; none sets a size, so the
 * tile keeps this pinned size across every state.
 *
 * @param text - Button text; a clock variable
 * @param size - Pinned text size
 * @returns Style
 */
function blackStyle(text: string, size: CompanionTextSize): CompanionButtonStyleProps {
	return {
		text: text,
		size: size,
		color: COLORS.DIM_TEXT,
		bgcolor: COLORS.BLACK,
	}
}

/**
 * Returns a glyph button style: a static `png64` glyph on top with a word label below
 *
 * The glyph is aligned `center:top` and the label `center:bottom`, so a feedback can recolour
 * the button or replace the label without disturbing the glyph. Idle fill is dark gray unless
 * `bgcolor`/`color` are given (the amber Start blocks pass their own).
 *
 * @param text - Word label, below the glyph; may contain variables
 * @param png64 - Glyph image constant from defaults.ts
 * @param overrides - Optional `bgcolor`, `color` and `size` overrides
 * @returns Style
 */
function glyphStyle(
	text: string,
	png64: string,
	overrides: { bgcolor?: number; color?: number; size?: CompanionTextSize } = {},
): CompanionButtonStyleProps {
	return {
		text: text,
		size: overrides.size ?? SIZE_BLOCK,
		color: overrides.color ?? COLORS.WHITE,
		bgcolor: overrides.bgcolor ?? COLORS.DARK_GRAY,
		png64: png64,
		pngalignment: 'center:top',
		alignment: 'center:bottom',
	}
}

/**
 * Returns a `simple` button preset whose press runs one action
 *
 * The typed overloads validate the action against the module's action manifest: a display-only preset
 * passes `null` and no options, and an action preset's `actionId` and `options` are checked against
 * that action's schema, so a misspelt id or option is a compile error.
 *
 * @param name - Preset name
 * @param style - Button style
 * @param actionId - Action run on press, or null for a display-only button
 * @param options - Action options
 * @param feedbacks - Feedbacks
 * @param notes - Optional operator notes, copied onto the button's Notes field when the preset is dropped
 * @returns Preset
 */
function buttonPreset(
	name: string,
	style: CompanionButtonStyleProps,
	actionId: null,
	options: Record<string, never>,
	feedbacks: SomePresetSimpleFeedbackEntry<BreakTimeInstanceTypes>[],
	notes?: string,
): CompanionSimplePresetDefinition<BreakTimeInstanceTypes>
function buttonPreset<K extends StringKeys<BreakTimeInstanceTypes['actions']>>(
	name: string,
	style: CompanionButtonStyleProps,
	actionId: K,
	options: CompanionPresetOptionValues<BreakTimeInstanceTypes['actions'][K]['options']>,
	feedbacks: SomePresetSimpleFeedbackEntry<BreakTimeInstanceTypes>[],
	notes?: string,
): CompanionSimplePresetDefinition<BreakTimeInstanceTypes>
function buttonPreset(
	name: string,
	style: CompanionButtonStyleProps,
	actionId: string | null,
	options: CompanionOptionValues,
	feedbacks: SomePresetSimpleFeedbackEntry<BreakTimeInstanceTypes>[],
	notes?: string,
): CompanionSimplePresetDefinition<BreakTimeInstanceTypes> {
	const preset: CompanionSimplePresetDefinition<BreakTimeInstanceTypes> = {
		type: 'simple',
		name: name,
		style: style,
		// actionId/options are validated by the typed overloads above; the implementation stays loose,
		// so the single-action step is asserted to the precise preset-action entry type here.
		steps: actionId
			? [
					{
						down: [
							{ actionId: actionId, options: options } as SomePresetActionEntry<BreakTimeInstanceTypes>,
						],
						up: [],
					},
				]
			: [],
		feedbacks: feedbacks,
	}

	if (notes !== undefined) {
		preset.notes = notes
	}

	return preset
}

/**
 * Returns a Set Armed Duration keypad preset for one fixed length
 *
 * Green while that length is the armed Count Down event's current duration (`armedDurationIs`),
 * dimmed text while the duration is locked — nothing armed, the armed event counts up or is
 * running, or not connected (`IncDecNotAllowed`).
 *
 * @param seconds - Duration to set, in seconds
 * @returns Preset
 */
function setDurationPreset(seconds: number): CompanionSimplePresetDefinition<BreakTimeInstanceTypes> {
	const label = formatClock(seconds)

	return buttonPreset(
		`Set Duration ${label}`,
		buttonStyle(label, SIZE_DURATION),
		'setArmedDuration',
		{ seconds: seconds },
		[
			{
				feedbackId: 'armedDurationIs',
				options: { seconds: seconds },
				style: { bgcolor: COLORS.GREEN, color: COLORS.BLACK },
			},
			{ feedbackId: 'IncDecNotAllowed', options: {}, style: { color: COLORS.DIM_TEXT } },
		],
		`Sets the armed event's duration to ${label}. Works only while the armed event is a stopped Count Down event. Turns green when this is its current duration.`,
	)
}

/**
 * Returns an Armed Duration + nudge preset for one step
 *
 * Dimmed text while the duration is locked (`IncDecNotAllowed`), the same guard the keypad uses.
 *
 * @param seconds - Seconds to add
 * @returns Preset
 */
function increaseNudgePreset(seconds: number): CompanionSimplePresetDefinition<BreakTimeInstanceTypes> {
	return buttonPreset(
		`Armed Duration +${seconds}s`,
		glyphStyle(`+${seconds}s`, PLUS_PNG64),
		'increaseDuration',
		{ duration: seconds },
		[{ feedbackId: 'IncDecNotAllowed', options: {}, style: { color: COLORS.DIM_TEXT } }],
		`Adds ${seconds} seconds to the armed event's duration. Works only while the armed event is a stopped Count Down event.`,
	)
}

/**
 * Returns an Armed Duration - nudge preset for one step
 *
 * @param seconds - Seconds to subtract
 * @returns Preset
 */
function decreaseNudgePreset(seconds: number): CompanionSimplePresetDefinition<BreakTimeInstanceTypes> {
	return buttonPreset(
		`Armed Duration -${seconds}s`,
		glyphStyle(`-${seconds}s`, MINUS_PNG64),
		'decreaseDuration',
		{ duration: seconds },
		[{ feedbackId: 'IncDecNotAllowed', options: {}, style: { color: COLORS.DIM_TEXT } }],
		`Takes ${seconds} seconds off the armed event's duration. Works only while the armed event is a stopped Count Down event.`,
	)
}

/**
 * Returns the idle-only START preset shared by the two Simple categories
 *
 * Amber play block that starts whatever is armed (`startSelected` on the armed sentinel), only
 * when nothing is running. Greys to the not-allowed colour while any event runs (`eventIsRunning`
 * target any), signalling the idle gate; the dark play glyph stays visible on the gray fill.
 *
 * @param firstEventId - First event ID, '' for an empty playlist; the unused `event` option of the any-target feedback
 * @returns Preset
 */
function simpleStartPreset(firstEventId: string): CompanionSimplePresetDefinition<BreakTimeInstanceTypes> {
	return buttonPreset(
		'Start (Armed, Idle Only)',
		glyphStyle('START', PLAY_PNG64, { bgcolor: COLORS.AMBER, color: COLORS.BLACK }),
		'startSelected',
		{ event: CHOICE_ARMED_EVENT.id, immediate: false, onlyWhenIdle: true },
		[
			{
				feedbackId: 'eventIsRunning',
				options: { target: 'any', event: firstEventId },
				style: { bgcolor: COLORS.GRAY, color: COLORS.BLACK },
			},
		],
		'Starts the armed event. Works only while nothing is running, and dims while an event is running so you cannot start a second.',
	)
}

/**
 * Returns the graceful END preset (latest running event)
 *
 * Stop block that ends the latest running event with pre-roll and correction. Red while any event
 * is running (`runningCountAtLeast` 1), dimmed text while nothing is running — the action ends the
 * latest running event, so the colour follows the running count, mirroring `Playlist_EndAll`.
 *
 * @returns Preset
 */
function endLatestPreset(): CompanionSimplePresetDefinition<BreakTimeInstanceTypes> {
	return buttonPreset(
		'End (Latest Running)',
		glyphStyle('END', STOP_PNG64, { color: COLORS.DIM_TEXT }),
		'endSelected',
		{ target: 'latest', immediate: false },
		[
			{
				feedbackId: 'runningCountAtLeast',
				options: { count: 1 },
				style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
			},
		],
		'Ends the latest running event cleanly, with pre-roll and correction. Turns red while an event is running, and dims while nothing is running.',
	)
}

/**
 * Returns the crash-out END NOW preset (latest running event)
 *
 * Lightning-bolt block that ends the latest running event immediately, no pre-roll or correction.
 * Same state colours as END: red while any event is running (`runningCountAtLeast` 1), dimmed text
 * while nothing is running; the bolt marks the instant crash-out.
 *
 * @returns Preset
 */
function endNowLatestPreset(): CompanionSimplePresetDefinition<BreakTimeInstanceTypes> {
	return buttonPreset(
		'End Now (Crash Out)',
		glyphStyle('END\\nNOW', BOLT_PNG64, { color: COLORS.DIM_TEXT }),
		'endSelected',
		{ target: 'latest', immediate: true },
		[
			{
				feedbackId: 'runningCountAtLeast',
				options: { count: 1 },
				style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
			},
		],
		'Ends the latest running event immediately, with no pre-roll or correction. Use it only when you need the event to stop right now. Time Signal events have no crash-out.',
	)
}

/**
 * Returns the armed-event status countdown tile shared by the two Simple categories
 *
 * Black-based mm:ss clock of the armed event's remaining time. Layered boolean feedbacks band it green
 * (`countingDown`), then amber then red (`remainingTimeBelow` at 20 s and 10 s, red listed last so it
 * wins), and leave it black while the armed event is stopped or counting up.
 *
 * @returns Preset
 */
function armedStatusTile(): CompanionSimplePresetDefinition<BreakTimeInstanceTypes> {
	return buttonPreset(
		'Status Countdown (Armed)',
		blackStyle('$(breaktime:selected_time_mmss)', SIZE_STATUS),
		null,
		{},
		[
			{
				feedbackId: 'countingDown',
				options: { target: 'armed' },
				style: { bgcolor: COLORS.GREEN, color: COLORS.WHITE },
			},
			{
				feedbackId: 'remainingTimeBelow',
				options: { target: 'armed', seconds: 20 },
				style: { bgcolor: COLORS.AMBER, color: COLORS.BLACK },
			},
			{
				feedbackId: 'remainingTimeBelow',
				options: { target: 'armed', seconds: 10 },
				style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
			},
		],
		"Shows the armed event's remaining time. Turns green, then amber, then red as the time runs down, and stays black while the armed event is stopped or counting up. Display only.",
	)
}

export const presets = {
	/**
	 * Registers every preset with Companion
	 *
	 * Expensive: called at init, when the event list changes and when the running slot
	 * count changes, never per frame. Builds the workflow preset definitions and the section
	 * structure that lists each preset ID in its category, in display order.
	 *
	 * @returns void
	 */
	initPresets(): void {
		const self: BreakTimeInstance = this

		const presets: CompanionPresetDefinitions<BreakTimeInstanceTypes> = {}
		const firstEventId = self.CHOICES_EVENTS[0]?.id ?? ''

		const fixedIds: string[] = []
		const variableIds: string[] = []
		const playlistIds: string[] = []
		const infoIds: string[] = []

		/** Stores a preset and records its ID in its category, so the structure keeps build order */
		const add = (
			ids: string[],
			id: string,
			preset: CompanionSimplePresetDefinition<BreakTimeInstanceTypes>,
		): void => {
			presets[id] = preset
			ids.push(id)
		}

		self.addSimpleFixedPresets(add, fixedIds, firstEventId)
		self.addSimpleVariablePresets(add, variableIds, firstEventId)
		self.addPlaylistPresets(add, playlistIds)
		self.addInfoPresets(add, infoIds)

		const structure: CompanionPresetSection<BreakTimeInstanceTypes>[] = [
			{ id: 'simple_fixed', name: 'Simple Workflow (Fixed)', definitions: fixedIds },
			{ id: 'simple_variable', name: 'Simple Workflow (Variable)', definitions: variableIds },
			{ id: 'playlist', name: 'Playlist Workflow', definitions: playlistIds },
			{ id: 'info', name: 'Info & Status', definitions: infoIds },
		]

		self.setPresetDefinitions(structure, presets)
	},

	/**
	 * Adds the Simple Workflow (Fixed) category: the Set Duration keypad, START, END, END NOW and the status tile
	 *
	 * Nine blocks for a single event with a small set of fixed lengths: five Set Duration tiles
	 * (0:30 to 3:00), the idle-only START, the graceful END and the crash-out END NOW (both on the
	 * latest running event), and the armed-event status countdown tile.
	 *
	 * @param add - Category adder (category list, preset ID, preset)
	 * @param ids - Simple Workflow (Fixed) ID list, filled in display order
	 * @param firstEventId - First event ID, '' for an empty playlist; the START feedback's `event` option
	 * @returns void
	 */
	addSimpleFixedPresets(
		add: (ids: string[], id: string, preset: CompanionSimplePresetDefinition<BreakTimeInstanceTypes>) => void,
		ids: string[],
		firstEventId: string,
	): void {
		for (const seconds of DURATION_PRESETS) {
			add(ids, `SimpleFixed_Duration_${seconds}`, setDurationPreset(seconds))
		}

		add(ids, 'SimpleFixed_Start', simpleStartPreset(firstEventId))
		add(ids, 'SimpleFixed_End', endLatestPreset())
		add(ids, 'SimpleFixed_EndNow', endNowLatestPreset())
		add(ids, 'SimpleFixed_Status', armedStatusTile())
	},

	/**
	 * Adds the Simple Workflow (Variable) category: the +/- nudges, START, END, END NOW and the status tile
	 *
	 * Eight blocks for a single event trimmed on the fly: the +30 s / -30 s / +5 s / -5 s duration
	 * nudges in place of the keypad, then the same idle-only START, graceful END, crash-out END NOW
	 * and armed-event status countdown tile as the Fixed category.
	 *
	 * @param add - Category adder
	 * @param ids - Simple Workflow (Variable) ID list, filled in display order
	 * @param firstEventId - First event ID, '' for an empty playlist; the START feedback's `event` option
	 * @returns void
	 */
	addSimpleVariablePresets(
		add: (ids: string[], id: string, preset: CompanionSimplePresetDefinition<BreakTimeInstanceTypes>) => void,
		ids: string[],
		firstEventId: string,
	): void {
		add(ids, 'SimpleVar_Increase_30', increaseNudgePreset(30))
		add(ids, 'SimpleVar_Decrease_30', decreaseNudgePreset(30))
		add(ids, 'SimpleVar_Increase_5', increaseNudgePreset(5))
		add(ids, 'SimpleVar_Decrease_5', decreaseNudgePreset(5))

		add(ids, 'SimpleVar_Start', simpleStartPreset(firstEventId))
		add(ids, 'SimpleVar_End', endLatestPreset())
		add(ids, 'SimpleVar_EndNow', endNowLatestPreset())
		add(ids, 'SimpleVar_Status', armedStatusTile())
	},

	/**
	 * Adds the Playlist Workflow category: the next-event readout, arm steppers, nudges, START, END NOW and END ALL
	 *
	 * Nine blocks for a playlist of events that may overlap: the next (armed) event name/duration
	 * readout, PREV / NEXT arm steppers, +5 s / -5 s nudges, START (not idle-gated, so several
	 * events can run at once), the crash-out END NOW on the latest, END ALL across every running
	 * event, and the latest-running status countdown tile.
	 *
	 * @param add - Category adder
	 * @param ids - Playlist Workflow ID list, filled in display order
	 * @returns void
	 */
	addPlaylistPresets(
		add: (ids: string[], id: string, preset: CompanionSimplePresetDefinition<BreakTimeInstanceTypes>) => void,
		ids: string[],
	): void {
		add(
			ids,
			'Playlist_NextReadout',
			buttonPreset(
				'Next Event (Name + Duration)',
				buttonStyle('$(breaktime:selected_name)\\n$(breaktime:selected_duration_mmss)', SIZE_LABEL),
				null,
				{},
				[],
				'Shows the name and duration of the armed event, the next to start. Display only.',
			),
		)

		add(
			ids,
			'Playlist_Prev',
			buttonPreset(
				'Previous Event',
				glyphStyle('PREV', CHEVRON_LEFT_PNG64),
				'selectPreviousEvent',
				{},
				[],
				'Arms the previous event in the playlist, wrapping from the first back to the last.',
			),
		)

		add(
			ids,
			'Playlist_Next',
			buttonPreset(
				'Next Event',
				glyphStyle('NEXT', CHEVRON_RIGHT_PNG64),
				'selectNextEvent',
				{},
				[],
				'Arms the next event in the playlist, wrapping from the last back to the first.',
			),
		)

		add(ids, 'Playlist_Increase_5', increaseNudgePreset(5))
		add(ids, 'Playlist_Decrease_5', decreaseNudgePreset(5))

		add(
			ids,
			'Playlist_Start',
			buttonPreset(
				'Start (Armed)',
				glyphStyle('START', PLAY_PNG64, { bgcolor: COLORS.AMBER, color: COLORS.BLACK }),
				'startSelected',
				{ event: CHOICE_ARMED_EVENT.id, immediate: false, onlyWhenIdle: false },
				[],
				'Starts the armed event. A playlist can run several events at once, so this does not block while an event is already running.',
			),
		)

		add(
			ids,
			'Playlist_EndNow',
			buttonPreset(
				'End Now (Crash Out)',
				glyphStyle('END\\nNOW', BOLT_PNG64),
				'endSelected',
				{ target: 'latest', immediate: true },
				[
					{
						feedbackId: 'runningCountAtLeast',
						options: { count: 1 },
						style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
					},
				],
				'Ends the latest running event immediately, with no pre-roll or correction. Use it only when you need the event to stop right now. Time Signal events have no crash-out.',
			),
		)

		add(
			ids,
			'Playlist_EndAll',
			buttonPreset(
				'End All Running',
				glyphStyle('END\\nALL', STOP_ALL_PNG64, { color: COLORS.DIM_TEXT }),
				'endSelected',
				{ target: 'all', immediate: false },
				[
					{
						feedbackId: 'runningCountAtLeast',
						options: { count: 1 },
						style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
					},
				],
				'Ends every running event at once. Turns red while one or more events are running.',
			),
		)

		add(
			ids,
			'Playlist_Status',
			buttonPreset(
				'Status Countdown (Latest Running)',
				blackStyle('$(breaktime:running_latest_time_mmss)', SIZE_STATUS),
				null,
				{},
				[
					{
						feedbackId: 'countingDown',
						options: { target: 'latest' },
						style: { bgcolor: COLORS.GREEN, color: COLORS.WHITE },
					},
					{
						feedbackId: 'remainingTimeBelow',
						options: { target: 'latest', seconds: 20 },
						style: { bgcolor: COLORS.AMBER, color: COLORS.BLACK },
					},
					{
						feedbackId: 'remainingTimeBelow',
						options: { target: 'latest', seconds: 10 },
						style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
					},
				],
				"Shows the latest running event's remaining time. Turns green, then amber, then red as the time runs down, and stays black while nothing is running, or the latest event is counting up. Display only.",
			),
		)
	},

	/**
	 * Adds the Info & Status category: the armed-event readouts, the running count and the link tiles
	 *
	 * Nine display-only blocks: the armed event's name, status (red running, dim stopped), duration,
	 * time and duration mode (green while Count Down); the running count (red while any run); the
	 * status / message line; and the SCTE 104 and vMix connectivity links.
	 *
	 * @param add - Category adder
	 * @param ids - Info & Status ID list, filled in display order
	 * @returns void
	 */
	addInfoPresets(
		add: (ids: string[], id: string, preset: CompanionSimplePresetDefinition<BreakTimeInstanceTypes>) => void,
		ids: string[],
	): void {
		const self: BreakTimeInstance = this

		add(
			ids,
			'Info_ArmedName',
			buttonPreset(
				'Armed Event Name',
				buttonStyle('$(breaktime:selected_name)', SIZE_LABEL),
				null,
				{},
				[],
				'Shows the name of the armed event. Display only.',
			),
		)

		add(
			ids,
			'Info_ArmedStatus',
			buttonPreset(
				'Armed Event Status',
				buttonStyle('$(breaktime:selected_status)', SIZE_READOUT),
				null,
				{},
				[
					{ feedbackId: 'selectedisFinished', options: {}, style: { color: COLORS.DIM_TEXT } },
					{
						feedbackId: 'selectedIsRunning',
						options: {},
						style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
					},
				],
				"Shows the armed event's status. Turns red while it is running, and dims while it is stopped. Display only.",
			),
		)

		add(
			ids,
			'Info_ArmedDuration',
			buttonPreset(
				'Armed Event Duration',
				buttonStyle('$(breaktime:selected_duration_mmss)', SIZE_READOUT),
				null,
				{},
				[],
				"Shows the armed event's set duration as minutes and seconds. Display only.",
			),
		)

		add(
			ids,
			'Info_ArmedTime',
			buttonPreset(
				'Armed Event Time',
				buttonStyle('$(breaktime:selected_time_mmss)', SIZE_READOUT),
				null,
				{},
				[],
				"Shows the armed event's time remaining (Count Down) or elapsed (Count Up) as minutes and seconds. Display only.",
			),
		)

		add(
			ids,
			'Info_ArmedMode',
			buttonPreset(
				'Armed Event Duration Mode',
				buttonStyle('$(breaktime:selected_duration_mode)', SIZE_BLOCK),
				null,
				{},
				[
					{
						feedbackId: 'selectedDurationMode',
						options: { mode: '0' },
						style: { bgcolor: COLORS.GREEN, color: COLORS.BLACK },
					},
				],
				'Shows whether the armed event is Count Up or Count Down. Turns green while it is Count Down. Display only.',
			),
		)

		add(
			ids,
			'Info_RunningCount',
			buttonPreset(
				'Running Count',
				buttonStyle('Running\\n$(breaktime:running_events_count)', SIZE_READOUT),
				null,
				{},
				[
					{
						feedbackId: 'runningCountAtLeast',
						options: { count: 1 },
						style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
					},
				],
				'Shows how many events are running. Turns red while one or more are running. Display only.',
			),
		)

		add(
			ids,
			'Info_Status',
			buttonPreset(
				'Status / Message',
				buttonStyle('No Warnings', SIZE_LABEL),
				null,
				{},
				[
					{
						feedbackId: 'temporaryWarning',
						options: { warning: self.CHOICE_ANY_WARNING.id },
						style: { bgcolor: COLORS.AMBER, color: COLORS.BLACK, text: '$(breaktime:message)' },
					},
					{
						feedbackId: 'haRoleAlarmActive',
						options: {},
						style: { bgcolor: COLORS.AMBER, color: COLORS.BLACK, text: '$(breaktime:message)' },
					},
					{
						feedbackId: 'haStandby',
						options: {},
						style: { bgcolor: COLORS.RED, color: COLORS.WHITE, text: 'STANDBY\\n$(breaktime:message)' },
					},
				],
				'Shows No Warnings at rest. Turns amber with the warning message while a warning or standing HA role alarm is active, and red STANDBY when this is the standby instance of a pair. Display only.',
			),
		)

		add(
			ids,
			'Info_Scte104Link',
			buttonPreset(
				'SCTE 104 Link',
				buttonStyle('SCTE 104\\n$(breaktime:scte104_injector_status)', SIZE_READOUT),
				null,
				{},
				[
					{
						feedbackId: 'scte104Connected',
						options: {},
						style: { bgcolor: COLORS.GREEN, color: COLORS.BLACK },
					},
					{
						feedbackId: 'scte104Disconnected',
						options: {},
						style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
					},
				],
				'Shows the connection status between BreakTime and the SCTE 104 Injector. Turns green when connected and red when enabled but disconnected, and stays dark gray otherwise. Display only.',
			),
		)

		add(
			ids,
			'Info_VmixLink',
			buttonPreset(
				'vMix Link',
				buttonStyle('vMix\\n$(breaktime:vmix_status)', SIZE_READOUT),
				null,
				{},
				[
					{ feedbackId: 'vMixConnected', options: {}, style: { bgcolor: COLORS.GREEN, color: COLORS.BLACK } },
					{
						feedbackId: 'vMixDisconnected',
						options: {},
						style: { bgcolor: COLORS.RED, color: COLORS.WHITE },
					},
				],
				'Shows the connection status between BreakTime and vMix. Turns green when connected and red when enabled but disconnected, and stays dark gray otherwise. Display only.',
			),
		)
	},
} satisfies ThisType<BreakTimeInstance>

/** The shape the `presets` methods add to the module class */
export type PresetsMixin = typeof presets
