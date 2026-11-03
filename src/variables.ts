/**
 * @fileoverview Variable definitions, the variable value builder and the change-detection push
 *
 * `checkVariables()` is the one place that writes variable values. It builds every value
 * from `this.DATA` (`buildVariableValues()`), a signature per feedback type
 * (`buildFeedbackState()` in feedbacks.ts) and a signature per event shown by an
 * `eventTile` (`buildTileSignatures()`), compares them with the snapshot of what was last
 * pushed, and sends only the changes: one batched `setVariableValues()` with the changed
 * keys, one `checkFeedbacks()` with the affected types and one `checkFeedbacksById()` with
 * the affected tiles. base diffs none of them. It runs from `processData()` on every state
 * frame, and from `refreshState()` in api.ts for every other state change.
 *
 * A null snapshot makes the next push a full one: every value in one `setVariableValues()`
 * and one `checkAllFeedbacks()`. It is set to null at init, when a socket opens, on
 * disconnect, on a host or port change and after every `setVariableDefinitions()`.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

import type { CompanionVariableDefinitions, CompanionVariableValue } from '@companion-module/base'
import type { BreakTimeInstanceTypes } from './main.js'
import type BreakTimeInstance from './main.js'
import type { BreakTimeEvent } from './api.js'

import { COMPONENTS, MAX_RUNNING_SLOTS, DEFAULT_RUNNING_SLOTS } from './defaults.js'

/** Variable IDs of one running slot */
interface SlotKeys {
	name: string
	id: string
	durationMode: string
	timeSs: string
	timeMmss: string
	timeHhmmss: string
	durationSs: string
	durationMmss: string
	durationHhmmss: string
	spliceEventId: string
	segmentationEventId: string
}

/**
 * Variable IDs of every possible running slot, built once so the per-frame builder allocates no key strings
 * Index 0 is slot 1. Example: SLOT_KEYS[0].timeMmss is 'running_1_time_mmss'
 */
const SLOT_KEYS: ReadonlyArray<SlotKeys> = Object.freeze(
	Array.from({ length: MAX_RUNNING_SLOTS }, (_unused, index) => {
		const prefix = `running_${index + 1}_`

		return Object.freeze({
			name: `${prefix}name`,
			id: `${prefix}id`,
			durationMode: `${prefix}duration_mode`,
			timeSs: `${prefix}time_ss`,
			timeMmss: `${prefix}time_mmss`,
			timeHhmmss: `${prefix}time_hhmmss`,
			durationSs: `${prefix}duration_ss`,
			durationMmss: `${prefix}duration_mmss`,
			durationHhmmss: `${prefix}duration_hhmmss`,
			spliceEventId: `${prefix}splice_event_id`,
			segmentationEventId: `${prefix}segmentation_event_id`,
		})
	}),
)

/**
 * Variable IDs of every component, built once for the same reason
 * Example: { slug: 'vmix', status: 'component_vmix', detail: 'component_vmix_detail' }
 */
const COMPONENT_KEYS: ReadonlyArray<{ slug: string; label: string; status: string; detail: string }> = Object.freeze(
	COMPONENTS.map((component) =>
		Object.freeze({
			slug: component.slug,
			label: component.key,
			status: `component_${component.slug}`,
			detail: `component_${component.slug}_detail`,
		}),
	),
)

/**
 * Returns the `True` / `False` text of a boolean frame field
 *
 * @param value - Field value
 * @returns '' when the value is not a boolean (unknown)
 */
function boolText(value: unknown): 'True' | 'False' | '' {
	return value === true ? 'True' : value === false ? 'False' : ''
}

/**
 * Returns an event's SCTE event ID for its message mode, or '' when it does not apply
 *
 * The splice ID applies only to Splice Insert (`MessageMode` 0) and the segmentation ID
 * only to Time Signal (1); 0 means none.
 *
 * @param event - Playlist event
 * @param messageMode - The message mode this ID belongs to
 * @param id - `ActuationSpliceEventID` or `ActuationSegmentationEventID`
 * @returns The ID, or ''
 */
function eventIdFor(event: BreakTimeEvent, messageMode: 0 | 1, id: number | undefined): number | '' {
	if (event.MessageMode === messageMode && typeof id === 'number' && Number.isInteger(id) && id !== 0) {
		return id
	}

	return ''
}

/**
 * Returns a running event's displayed time in milliseconds: remaining for Count Down, elapsed for Count Up
 *
 * @param event - Running event
 * @returns Time in ms, NaN for an unknown duration mode (shown as '')
 */
function runningTimeMs(event: BreakTimeEvent): number {
	const mode = event.DurationMode

	return ((mode === 0 ? event.RemainingSeconds : mode === 1 ? event.ElapsedSeconds : NaN) ?? NaN) * 1000
}

/**
 * Returns the display name of an event's duration mode
 *
 * @param event - Playlist event
 * @returns '' for an unknown mode
 */
function durationModeText(event: BreakTimeEvent): 'Count Down' | 'Count Up' | '' {
	return event.DurationMode === 0 ? 'Count Down' : event.DurationMode === 1 ? 'Count Up' : ''
}

export const variables = {
	/**
	 * Registers every variable definition with Companion
	 *
	 * Expensive, and it replaces the whole set (base re-seeds re-added IDs as ''), so the
	 * caller sets the snapshot to null and pushes every value afterwards. The number of
	 * running slots comes from the normalized `runningSlots` config value. base 2.x takes
	 * the definitions as an object keyed by variable ID.
	 *
	 * @returns void
	 */
	initVariables(): void {
		const self: BreakTimeInstance = this

		const variables: CompanionVariableDefinitions<BreakTimeInstanceTypes['variables']> = {}

		variables.running_events_count = { name: 'Running Events Count' }
		variables.running_events_json = { name: 'Running Events (JSON)' }

		variables.running_latest_name = { name: 'Latest Running Event Name' }
		variables.running_latest_id = { name: 'Latest Running Event ID' }
		variables.running_latest_duration_mode = { name: 'Latest Running Event Duration Mode' }
		variables.running_latest_time_ss = { name: 'Latest Running Event Time Remaining/Elapsed (Seconds)' }
		variables.running_latest_time_mmss = { name: 'Latest Running Event Time Remaining/Elapsed (MM:SS)' }
		variables.running_latest_time_hhmmss = { name: 'Latest Running Event Time Remaining/Elapsed (HH:MM:SS)' }

		variables.selected_name = { name: 'Armed Event Name' }
		variables.selected_status = { name: 'Armed Event Status' }

		variables.selected_duration_ss = { name: 'Armed Event Duration (Seconds)' }
		variables.selected_duration_mmss = { name: 'Armed Event Duration (MM:SS)' }
		variables.selected_duration_hhmmss = { name: 'Armed Event Duration (HH:MM:SS)' }

		variables.selected_time_ss = { name: 'Armed Event Time Remaining/Elapsed (Seconds)' }
		variables.selected_time_mmss = { name: 'Armed Event Time Remaining/Elapsed (MM:SS)' }
		variables.selected_time_hhmmss = { name: 'Armed Event Time Remaining/Elapsed (HH:MM:SS)' }

		variables.selected_duration_mode = { name: 'Armed Event Duration Mode' }

		for (let slot = 1; slot <= self.getRunningSlotCount(); slot++) {
			const keys = SLOT_KEYS[slot - 1]
			const label = `Running Slot ${slot}`

			variables[keys.name] = { name: `${label} Name` }
			variables[keys.id] = { name: `${label} Event ID` }
			variables[keys.durationMode] = { name: `${label} Duration Mode` }
			variables[keys.timeSs] = { name: `${label} Time Remaining/Elapsed (Seconds)` }
			variables[keys.timeMmss] = { name: `${label} Time Remaining/Elapsed (MM:SS)` }
			variables[keys.timeHhmmss] = { name: `${label} Time Remaining/Elapsed (HH:MM:SS)` }
			variables[keys.durationSs] = { name: `${label} Duration (Seconds)` }
			variables[keys.durationMmss] = { name: `${label} Duration (MM:SS)` }
			variables[keys.durationHhmmss] = { name: `${label} Duration (HH:MM:SS)` }
			variables[keys.spliceEventId] = { name: `${label} Splice Event ID` }
			variables[keys.segmentationEventId] = { name: `${label} Segmentation Event ID` }
		}

		variables.scte104_injector_status_bool = { name: 'SCTE 104 Injector Connected (True/False)' }
		variables.scte104_injector_status = { name: 'SCTE 104 Injector Status' }
		variables.scte104_splice_event_id = { name: 'Last Started Splice Event ID' }
		variables.scte104_segmentation_event_id = { name: 'Last Started Segmentation Event ID' }

		variables.vmix_status_bool = { name: 'vMix Connected (True/False)' }
		variables.vmix_status = { name: 'vMix Connectivity Status' }

		for (const component of COMPONENT_KEYS) {
			variables[component.status] = { name: `${component.label} Status` }
			variables[component.detail] = { name: `${component.label} Status Detail` }
		}

		variables.ha_role = { name: 'HA Role' }
		variables.ha_acting = { name: 'HA Live (True/False)' }
		variables.ha_link_state = { name: 'HA Link State' }
		variables.ha_emit_ready = { name: 'HA Ready to Send (True/False)' }

		variables.message = { name: 'Current Message' }
		variables.warning = { name: 'Warning Showing (True/False)' }

		variables.breaktime_version = { name: 'BreakTime Version' }
		variables.breaktime_security = { name: 'BreakTime Security' }

		self.setVariableDefinitions(variables)
	},

	/**
	 * Returns the configured number of running slots
	 *
	 * @returns The normalized `runningSlots` value, DEFAULT_RUNNING_SLOTS before config is applied
	 */
	getRunningSlotCount(): number {
		const self: BreakTimeInstance = this

		return self.config.runningSlots ?? DEFAULT_RUNNING_SLOTS
	},

	/**
	 * Pushes the variables that changed and re-checks the feedbacks whose inputs changed
	 *
	 * Runs on every state frame (hot path) and after every other state change. Throws are
	 * not caught here: `processData()` and `refreshState()` wrap every caller.
	 *
	 * @returns void
	 */
	checkVariables(): void {
		const self: BreakTimeInstance = this

		const values = self.buildVariableValues()
		const feedbacks = self.buildFeedbackState()
		const tiles = self.buildTileSignatures()
		const previous = self.snapshot

		if (previous === null) {
			self.setVariableValues(values)
			self.checkAllFeedbacks()
		} else {
			let changedValues: Record<string, CompanionVariableValue> | null = null
			let changedTypes: string[] | null = null
			let changedTiles: string[] | null = null

			for (const variableId in values) {
				if (values[variableId] !== previous.values[variableId]) {
					changedValues ??= {}
					changedValues[variableId] = values[variableId]
				}
			}

			for (const type in feedbacks) {
				if (feedbacks[type] !== previous.feedbacks[type]) {
					changedTypes ??= []
					changedTypes.push(type)
				}
			}

			for (const [feedbackId, eventId] of self.tileFeedbacks) {
				if (tiles[eventId] !== previous.tiles[eventId]) {
					changedTiles ??= []
					changedTiles.push(feedbackId)
				}
			}

			if (changedValues !== null) {
				self.setVariableValues(changedValues)
			}

			if (changedTypes !== null) {
				// changedTypes is non-empty here; checkFeedbacks requires at least one type
				self.checkFeedbacks(...(changedTypes as [string, ...string[]]))
			}

			if (changedTiles !== null) {
				self.checkFeedbacksById(...changedTiles)
			}
		}

		self.snapshot = { values: values, feedbacks: feedbacks, tiles: tiles }
	},

	/**
	 * Returns the `message` variable text: the active timed warning, otherwise the HA role alarm, otherwise ''
	 *
	 * The single source of `message`: called on every push, so it follows a warning being
	 * raised or expiring, every frame (including the alarm going from non-null to null), and
	 * a disconnect (the alarm is null while the WebSocket is down).
	 *
	 * @returns Message text
	 */
	getMessageText(): string {
		const self: BreakTimeInstance = this
		const DATA = self.DATA

		if (DATA.temporaryWarning) {
			return DATA.warningText
		}

		return DATA.haRoleAlarm ?? ''
	},

	/**
	 * Builds every variable value from the cached BreakTime state
	 *
	 * The status variables are always computed. Armed (`selected_*`) values: `No Event Armed`
	 * with nothing armed; `Unknown` status with the mode, durations and times '' while the run
	 * state is unknown; otherwise the armed event's duration (or a pending Set Armed Duration
	 * target) and its live time. Durations are '' at 0 s (1.0.3 behavior). Each running slot
	 * shows the event that holds it; empty slots are ''. The running count, every slot, the
	 * latest running values and `running_events_json` are '' while the WebSocket is down.
	 *
	 * @returns Every variable value, keyed by variable ID
	 */
	buildVariableValues(): Record<string, string | number> {
		const self: BreakTimeInstance = this

		const DATA = self.DATA
		const armed = DATA.selectedEvent
		const values: Record<string, string | number> = {}

		values.running_events_count = DATA.runningEventsCount

		if (!armed) {
			values.selected_name = 'No Event Armed'
			values.selected_status = ''
			values.selected_duration_mode = ''
			values.selected_duration_ss = ''
			values.selected_duration_mmss = ''
			values.selected_duration_hhmmss = ''
			values.selected_time_ss = ''
			values.selected_time_mmss = ''
			values.selected_time_hhmmss = ''
		} else {
			const countDown = armed.DurationMode === 0
			const countUp = armed.DurationMode === 1
			// A pending Set Armed Duration target, so START and the duration readouts follow a press at once
			const durationSeconds = self.getArmedDuration() ?? NaN
			const durationMs = durationSeconds === 0 ? NaN : durationSeconds * 1000

			let timeMs = NaN

			if (armed.Status === 1) {
				timeMs = ((countDown ? armed.RemainingSeconds : countUp ? armed.ElapsedSeconds : NaN) ?? NaN) * 1000
			} else if (armed.Status === 0) {
				timeMs = countDown ? durationSeconds * 1000 : countUp ? 0 : NaN
			}

			values.selected_name = armed.Name ?? ''
			values.selected_status = armed.Status === 1 ? 'Running' : armed.Status === 0 ? 'Stopped' : 'Unknown'
			values.selected_duration_mode = countDown ? 'Count Down' : countUp ? 'Count Up' : ''
			values.selected_duration_ss = self.convertTime(durationMs, 'ss')
			values.selected_duration_mmss = self.convertTime(durationMs, 'mm:ss')
			values.selected_duration_hhmmss = self.convertTime(durationMs, 'hh:mm:ss')
			values.selected_time_ss = self.convertTime(timeMs, 'ss')
			values.selected_time_mmss = self.convertTime(timeMs, 'mm:ss')
			values.selected_time_hhmmss = self.convertTime(timeMs, 'hh:mm:ss')
		}

		self.buildRunningValues(values)

		values.scte104_injector_status_bool = DATA.scte104Status === 'Connected' ? 'True' : 'False'
		values.scte104_injector_status = DATA.scte104Status
		values.scte104_splice_event_id = DATA.scte104SpliceEventID
		values.scte104_segmentation_event_id = DATA.scte104SegmentationEventID

		values.vmix_status_bool = DATA.vmixStatus === 'Connected' ? 'True' : 'False'
		values.vmix_status = DATA.vmixStatus

		for (const component of COMPONENT_KEYS) {
			const state = DATA.components[component.slug]

			values[component.status] = state.status
			values[component.detail] = state.detail
		}

		const ha = DATA.ha

		values.ha_role = typeof ha?.Role === 'string' ? ha.Role : ''
		values.ha_acting = boolText(ha?.Acting)
		values.ha_link_state = typeof ha?.LinkState === 'string' ? ha.LinkState : ''
		values.ha_emit_ready = boolText(ha?.EmitReady)

		values.message = self.getMessageText()
		values.warning = DATA.temporaryWarning ? 'True' : 'False'

		values.breaktime_version = DATA.breaktimeVersion
		values.breaktime_security = DATA.breaktimeSecurity

		return values
	},

	/**
	 * Adds the running slot values, the latest running values and `running_events_json` to a value set
	 *
	 * Each slot shows the event that holds it in `DATA.slotEvents` (fixed slots). The latest
	 * running values show `DATA.running[0]`, the newest running event. Times: `RemainingSeconds`
	 * for Count Down, `ElapsedSeconds` for Count Up. Slot durations are '' at 0 s. The JSON
	 * lists every running event, newest first, with integer modes, a null `remainingSeconds`
	 * for Count Up, null SCTE IDs where they do not apply, and `slot` null while an event has
	 * no slot.
	 *
	 * @param values - Value set to fill
	 * @returns void
	 */
	buildRunningValues(values: Record<string, string | number>): void {
		const self: BreakTimeInstance = this

		const DATA = self.DATA
		const running = DATA.running
		const slotEvents = DATA.slotEvents
		const known = DATA.runningEventsCount !== ''
		const slots = self.getRunningSlotCount()

		for (let slot = 0; slot < slots; slot++) {
			const keys = SLOT_KEYS[slot]
			const event = slotEvents[slot]

			if (!event) {
				values[keys.name] = ''
				values[keys.id] = ''
				values[keys.durationMode] = ''
				values[keys.timeSs] = ''
				values[keys.timeMmss] = ''
				values[keys.timeHhmmss] = ''
				values[keys.durationSs] = ''
				values[keys.durationMmss] = ''
				values[keys.durationHhmmss] = ''
				values[keys.spliceEventId] = ''
				values[keys.segmentationEventId] = ''
				continue
			}

			const timeMs = runningTimeMs(event)
			const durationMs = event.DurationSeconds === 0 ? NaN : (event.DurationSeconds ?? NaN) * 1000

			values[keys.name] = event.Name ?? ''
			values[keys.id] = event.ID ?? ''
			values[keys.durationMode] = durationModeText(event)
			values[keys.timeSs] = self.convertTime(timeMs, 'ss')
			values[keys.timeMmss] = self.convertTime(timeMs, 'mm:ss')
			values[keys.timeHhmmss] = self.convertTime(timeMs, 'hh:mm:ss')
			values[keys.durationSs] = self.convertTime(durationMs, 'ss')
			values[keys.durationMmss] = self.convertTime(durationMs, 'mm:ss')
			values[keys.durationHhmmss] = self.convertTime(durationMs, 'hh:mm:ss')
			values[keys.spliceEventId] = eventIdFor(event, 0, event.ActuationSpliceEventID)
			values[keys.segmentationEventId] = eventIdFor(event, 1, event.ActuationSegmentationEventID)
		}

		const latest = running[0]

		if (!latest) {
			values.running_latest_name = ''
			values.running_latest_id = ''
			values.running_latest_duration_mode = ''
			values.running_latest_time_ss = ''
			values.running_latest_time_mmss = ''
			values.running_latest_time_hhmmss = ''
		} else {
			const timeMs = runningTimeMs(latest)

			values.running_latest_name = latest.Name ?? ''
			values.running_latest_id = latest.ID ?? ''
			values.running_latest_duration_mode = durationModeText(latest)
			values.running_latest_time_ss = self.convertTime(timeMs, 'ss')
			values.running_latest_time_mmss = self.convertTime(timeMs, 'mm:ss')
			values.running_latest_time_hhmmss = self.convertTime(timeMs, 'hh:mm:ss')
		}

		if (!known) {
			values.running_events_json = ''
		} else if (running.length === 0) {
			values.running_events_json = '[]'
		} else {
			values.running_events_json = JSON.stringify(
				running.map((event) => ({
					id: event.ID,
					name: event.Name,
					durationMode: event.DurationMode,
					durationSeconds: event.DurationSeconds,
					elapsedSeconds: event.ElapsedSeconds,
					remainingSeconds: event.DurationMode === 1 ? null : event.RemainingSeconds,
					messageMode: event.MessageMode,
					spliceEventId: eventIdFor(event, 0, event.ActuationSpliceEventID) || null,
					segmentationEventId: eventIdFor(event, 1, event.ActuationSegmentationEventID) || null,
					slot: DATA.slotByEventId.get(event.ID) ?? null,
				})),
			)
		}
	},
} satisfies ThisType<BreakTimeInstance>

/** The shape the `variables` methods add to the module class */
export type VariablesMixin = typeof variables
