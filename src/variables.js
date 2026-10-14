/**
 * @fileoverview Variable definitions, the variable value builder and the change-detection push
 *
 * `checkVariables()` is the one place that writes variable values. It builds every value
 * from `this.DATA` (`buildVariableValues()`), a signature per feedback type
 * (`buildFeedbackState()` in feedbacks.js) and a signature per event shown by an
 * `eventTile` (`buildTileSignatures()`), compares them with the snapshot of what was last
 * pushed, and sends only the changes: one batched `setVariableValues()` with the changed
 * keys, one `checkFeedbacks()` with the affected types and one `checkFeedbacksById()` with
 * the affected tiles. base diffs none of them. It runs from `processData()` on every state
 * frame, and from `refreshState()` in api.js for every other state change (init, config
 * changes, pre-connect check results, timed warnings and their expiry, disconnect, pending
 * durations, an accepted arm). The only feedback check outside it is in
 * `rebuildEventChoices()` (api.js), which re-checks every `eventTile` once when the
 * playlist changes.
 *
 * A null snapshot makes the next push a full one: every value in one `setVariableValues()`
 * and one `checkFeedbacks()` for every feedback type. It is set to null at init, when a
 * socket opens, on disconnect, on a host or port change and after every
 * `setVariableDefinitions()`.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

const { COMPONENTS, MAX_RUNNING_SLOTS, DEFAULT_RUNNING_SLOTS } = require('./defaults')

/**
 * Variable IDs of one running slot
 * @typedef {Object} SlotKeys
 * @property {string} name - `running_<n>_name`
 * @property {string} id - `running_<n>_id`
 * @property {string} durationMode - `running_<n>_duration_mode`
 * @property {string} timeSs - `running_<n>_time_ss`
 * @property {string} timeMmss - `running_<n>_time_mmss`
 * @property {string} timeHhmmss - `running_<n>_time_hhmmss`
 * @property {string} durationSs - `running_<n>_duration_ss`
 * @property {string} durationMmss - `running_<n>_duration_mmss`
 * @property {string} durationHhmmss - `running_<n>_duration_hhmmss`
 * @property {string} spliceEventId - `running_<n>_splice_event_id`
 * @property {string} segmentationEventId - `running_<n>_segmentation_event_id`
 */

/**
 * Variable IDs of every possible running slot, built once so the per-frame builder allocates no key strings
 * Index 0 is slot 1. Example: SLOT_KEYS[0].timeMmss is 'running_1_time_mmss'
 * @type {ReadonlyArray<SlotKeys>}
 */
const SLOT_KEYS = Object.freeze(
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
 * @type {ReadonlyArray<{slug: string, label: string, status: string, detail: string}>}
 */
const COMPONENT_KEYS = Object.freeze(
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
 * @private
 * @param {*} value - Field value
 * @returns {'True'|'False'|''} '' when the value is not a boolean (unknown)
 */
function boolText(value) {
	return value === true ? 'True' : value === false ? 'False' : ''
}

/**
 * Returns an event's SCTE event ID for its message mode, or '' when it does not apply
 *
 * The splice ID applies only to Splice Insert (`MessageMode` 0) and the segmentation ID
 * only to Time Signal (1); 0 means none.
 *
 * @private
 * @param {import('./api').BreakTimeEvent} event - Playlist event
 * @param {0|1} messageMode - The message mode this ID belongs to
 * @param {*} id - `ActuationSpliceEventID` or `ActuationSegmentationEventID`
 * @returns {number|''} The ID, or ''
 */
function eventIdFor(event, messageMode, id) {
	return event.MessageMode === messageMode && Number.isInteger(id) && id !== 0 ? id : ''
}

/**
 * Returns a running event's displayed time in milliseconds: remaining for Count Down, elapsed for Count Up
 *
 * @private
 * @param {import('./api').BreakTimeEvent} event - Running event
 * @returns {number} Time in ms, NaN for an unknown duration mode (shown as '')
 */
function runningTimeMs(event) {
	const mode = event.DurationMode

	return (mode === 0 ? event.RemainingSeconds : mode === 1 ? event.ElapsedSeconds : NaN) * 1000
}

/**
 * Returns the display name of an event's duration mode
 *
 * @private
 * @param {import('./api').BreakTimeEvent} event - Playlist event
 * @returns {'Count Down'|'Count Up'|''} '' for an unknown mode
 */
function durationModeText(event) {
	return event.DurationMode === 0 ? 'Count Down' : event.DurationMode === 1 ? 'Count Up' : ''
}

module.exports = {
	/**
	 * Registers every variable definition with Companion
	 *
	 * Expensive, and it replaces the whole set (base re-seeds re-added IDs as ''), so the
	 * caller sets the snapshot to null and pushes every value afterwards. The number of
	 * running slots comes from the normalized `runningSlots` config value.
	 *
	 * @returns {void}
	 */
	initVariables: function () {
		let self = this

		let variables = []

		variables.push({ variableId: 'running_events_count', name: 'Running Events Count' })
		variables.push({ variableId: 'running_events_json', name: 'Running Events (JSON)' })

		variables.push({ variableId: 'running_latest_name', name: 'Latest Running Event Name' })
		variables.push({ variableId: 'running_latest_id', name: 'Latest Running Event ID' })
		variables.push({ variableId: 'running_latest_duration_mode', name: 'Latest Running Event Duration Mode' })
		variables.push({
			variableId: 'running_latest_time_ss',
			name: 'Latest Running Event Time Remaining/Elapsed (Seconds)',
		})
		variables.push({
			variableId: 'running_latest_time_mmss',
			name: 'Latest Running Event Time Remaining/Elapsed (MM:SS)',
		})
		variables.push({
			variableId: 'running_latest_time_hhmmss',
			name: 'Latest Running Event Time Remaining/Elapsed (HH:MM:SS)',
		})

		variables.push({ variableId: 'selected_name', name: 'Armed Event Name' })
		variables.push({ variableId: 'selected_status', name: 'Armed Event Status' })

		variables.push({ variableId: 'selected_duration_ss', name: 'Armed Event Duration (Seconds)' })
		variables.push({ variableId: 'selected_duration_mmss', name: 'Armed Event Duration (MM:SS)' })
		variables.push({ variableId: 'selected_duration_hhmmss', name: 'Armed Event Duration (HH:MM:SS)' })

		variables.push({ variableId: 'selected_time_ss', name: 'Armed Event Time Remaining/Elapsed (Seconds)' })
		variables.push({ variableId: 'selected_time_mmss', name: 'Armed Event Time Remaining/Elapsed (MM:SS)' })
		variables.push({ variableId: 'selected_time_hhmmss', name: 'Armed Event Time Remaining/Elapsed (HH:MM:SS)' })

		variables.push({ variableId: 'selected_duration_mode', name: 'Armed Event Duration Mode' })

		for (let slot = 1; slot <= self.getRunningSlotCount(); slot++) {
			const keys = SLOT_KEYS[slot - 1]
			const label = `Running Slot ${slot}`

			variables.push({ variableId: keys.name, name: `${label} Name` })
			variables.push({ variableId: keys.id, name: `${label} Event ID` })
			variables.push({ variableId: keys.durationMode, name: `${label} Duration Mode` })
			variables.push({ variableId: keys.timeSs, name: `${label} Time Remaining/Elapsed (Seconds)` })
			variables.push({ variableId: keys.timeMmss, name: `${label} Time Remaining/Elapsed (MM:SS)` })
			variables.push({ variableId: keys.timeHhmmss, name: `${label} Time Remaining/Elapsed (HH:MM:SS)` })
			variables.push({ variableId: keys.durationSs, name: `${label} Duration (Seconds)` })
			variables.push({ variableId: keys.durationMmss, name: `${label} Duration (MM:SS)` })
			variables.push({ variableId: keys.durationHhmmss, name: `${label} Duration (HH:MM:SS)` })
			variables.push({ variableId: keys.spliceEventId, name: `${label} Splice Event ID` })
			variables.push({ variableId: keys.segmentationEventId, name: `${label} Segmentation Event ID` })
		}

		variables.push({ variableId: 'scte104_injector_status_bool', name: 'SCTE 104 Injector Connected (True/False)' })
		variables.push({ variableId: 'scte104_injector_status', name: 'SCTE 104 Injector Status' })
		variables.push({ variableId: 'scte104_splice_event_id', name: 'Last Started Splice Event ID' })
		variables.push({ variableId: 'scte104_segmentation_event_id', name: 'Last Started Segmentation Event ID' })

		variables.push({ variableId: 'vmix_status_bool', name: 'vMix Connected (True/False)' })
		variables.push({ variableId: 'vmix_status', name: 'vMix Connectivity Status' })

		for (const component of COMPONENT_KEYS) {
			variables.push({ variableId: component.status, name: `${component.label} Status` })
			variables.push({ variableId: component.detail, name: `${component.label} Status Detail` })
		}

		variables.push({ variableId: 'ha_role', name: 'HA Role' })
		variables.push({ variableId: 'ha_acting', name: 'HA Live (True/False)' })
		variables.push({ variableId: 'ha_link_state', name: 'HA Link State' })
		variables.push({ variableId: 'ha_emit_ready', name: 'HA Ready to Send (True/False)' })

		variables.push({ variableId: 'message', name: 'Current Message' })
		variables.push({ variableId: 'warning', name: 'Warning Showing (True/False)' })

		variables.push({ variableId: 'breaktime_version', name: 'BreakTime Version' })
		variables.push({ variableId: 'breaktime_security', name: 'BreakTime Security' })

		self.setVariableDefinitions(variables)
	},

	/**
	 * Returns the configured number of running slots
	 *
	 * @returns {number} The normalized `runningSlots` value, DEFAULT_RUNNING_SLOTS before config is applied
	 */
	getRunningSlotCount: function () {
		return this.config?.runningSlots ?? DEFAULT_RUNNING_SLOTS
	},

	/**
	 * Pushes the variables that changed and re-checks the feedbacks whose inputs changed
	 *
	 * Runs on every state frame (hot path) and after every other state change. Throws are
	 * not caught here: `processData()` and `refreshState()` wrap every caller.
	 *
	 * @returns {void}
	 */
	checkVariables: function () {
		let self = this

		const values = self.buildVariableValues()
		const feedbacks = self.buildFeedbackState()
		const tiles = self.buildTileSignatures()
		const previous = self.snapshot

		if (previous === null) {
			self.setVariableValues(values)
			self.checkFeedbacks()
		} else {
			let changedValues = null
			let changedTypes = null
			let changedTiles = null

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
				self.checkFeedbacks(...changedTypes)
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
	 * @returns {string} Message text
	 */
	getMessageText: function () {
		const DATA = this.DATA

		if (DATA.temporaryWarning) {
			return DATA.warningText
		}

		return DATA.haRoleAlarm ?? ''
	},

	/**
	 * Builds every variable value from the cached BreakTime state
	 *
	 * The status variables (SCTE 104, vMix, components, `message`, `warning`) are always
	 * computed, whether or not anything is armed. Armed (`selected_*`) values:
	 * - nothing armed: `selected_name` is `No Event Armed`, everything else ''.
	 * - run state unknown (WebSocket down, the event keeps only ID and name):
	 *   `selected_status` is `Unknown`, the mode, durations and times are ''.
	 * - durations are the armed event's `DurationSeconds`, or a pending Set Armed Duration
	 *   target no frame shows yet (`getArmedDuration()`), so the Operator Panel START label
	 *   follows a press at once, like the duration buttons and the armed tile.
	 * - times: Count Down shows `RemainingSeconds` while running and the duration above
	 *   when stopped; Count Up shows `ElapsedSeconds` while running and 0 when stopped.
	 * - durations are '' at 0 s (1.0.3 behavior, lead decision); `_ss` values are numbers.
	 *
	 * Each running slot shows the event that holds it (an event keeps its slot until it
	 * ends, see `assignRunningSlots()` in api.js); empty slots are ''. The latest running
	 * values show the newest running event, the one End `latest` ends. The running count,
	 * every slot, the latest running values and `running_events_json` are '' while the
	 * WebSocket is down, so "unknown" never reads as "nothing running". HA values are ''
	 * while the WebSocket is down; a component whose key is missing (or any component while
	 * down) is `Unknown`.
	 *
	 * @returns {Object<string, string|number>} Every variable value, keyed by variable ID
	 */
	buildVariableValues: function () {
		let self = this

		const DATA = self.DATA
		const armed = DATA.selectedEvent
		const values = {}

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
			const durationSeconds = self.getArmedDuration()
			const durationMs = durationSeconds === 0 ? NaN : durationSeconds * 1000

			let timeMs = NaN

			if (armed.Status === 1) {
				timeMs = (countDown ? armed.RemainingSeconds : countUp ? armed.ElapsedSeconds : NaN) * 1000
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
	 * Each slot shows the event that holds it in `DATA.slotEvents` (fixed slots, filled by
	 * `assignRunningSlots()` in api.js). The latest running values (`running_latest_*`)
	 * show `DATA.running[0]`, the newest running event by `StartMS` and the one End
	 * `latest` ends. Times: `RemainingSeconds` for Count Down, `ElapsedSeconds` for Count
	 * Up. Slot durations are '' at 0 s, like the armed ones. The JSON lists every running
	 * event (not only those holding a slot), newest first, as an object with the keys `id`,
	 * `name`, `durationMode`, `durationSeconds`, `elapsedSeconds`, `remainingSeconds`,
	 * `messageMode`, `spliceEventId`, `segmentationEventId` and `slot`. Modes are
	 * integers, `remainingSeconds` is null for Count Up, an SCTE event ID is null when it
	 * does not apply to the event's message mode (or is 0), and `slot` is the event's fixed
	 * slot number, or null while it has no slot (more events running than slots).
	 *
	 * @private
	 * @param {Object<string, string|number>} values - Value set to fill
	 * @returns {void}
	 */
	buildRunningValues: function (values) {
		let self = this

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
			const durationMs = event.DurationSeconds === 0 ? NaN : event.DurationSeconds * 1000

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
}
