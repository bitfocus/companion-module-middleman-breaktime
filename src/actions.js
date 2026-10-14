/**
 * @fileoverview Action definitions for the BreakTime module
 *
 * Each callback awaits its handler in api.js, so Companion's action call resolves only
 * after BreakTime answered (or REST_TIMEOUT_MS passed). The exception is an arm press made
 * while another arm request is in flight: it is folded into the next request and returns
 * at once (see `armEvent()` in api.js). Handlers never throw, and each one receives the
 * raw `action.options`: an option missing from a button created before it existed (or
 * from a preset) is treated as its definition default by the handler.
 *
 * Stored action IDs are unchanged from 1.0.3; only the display names changed
 * ("Selected" is now "Armed", matching the BreakTime UI).
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

module.exports = {
	/**
	 * Registers every action definition with Companion
	 *
	 * Expensive: call at init and only again when a definition or its choices change
	 * (the event list, see `processData`).
	 *
	 * @returns {void}
	 */
	initActions: function () {
		let self = this

		let actions = {}

		const immediateOption = {
			type: 'checkbox',
			label: 'Immediate',
			id: 'immediate',
			default: false,
			tooltip: 'Crash out: splice now, with no pre-roll or correction. Time Signal events have no crash-out.',
		}

		actions.startSelected = {
			name: 'Start Event',
			options: [
				{
					type: 'dropdown',
					label: 'Event',
					id: 'event',
					default: self.CHOICE_ARMED_EVENT.id,
					choices: [self.CHOICE_ARMED_EVENT, ...self.CHOICES_EVENTS],
				},
				immediateOption,
				{
					type: 'checkbox',
					label: 'Only when no event is running',
					id: 'onlyWhenIdle',
					default: false,
				},
			],
			callback: async function (action) {
				await self.startSelected(action.options)
			},
		}

		actions.startArmed = {
			name: 'Start Armed Event',
			options: [immediateOption],
			callback: async function (action) {
				await self.startArmed(action.options)
			},
		}

		actions.endSelected = {
			name: 'End Running Event',
			options: [
				{
					type: 'dropdown',
					label: 'Target',
					id: 'target',
					default: self.CHOICES_END_TARGETS[0].id,
					choices: self.CHOICES_END_TARGETS,
				},
				{
					type: 'dropdown',
					label: 'Event',
					id: 'event',
					default: self.CHOICES_EVENTS[0]?.id ?? '',
					choices: self.CHOICES_EVENTS,
					isVisibleExpression: "$(options:target) == 'specific'",
				},
				immediateOption,
			],
			callback: async function (action) {
				await self.endSelected(action.options)
			},
		}

		actions.selectNextEvent = {
			name: 'Arm Next',
			options: [],
			callback: async function () {
				await self.selectNextEvent()
			},
		}

		actions.selectPreviousEvent = {
			name: 'Arm Previous',
			options: [],
			callback: async function () {
				await self.selectPreviousEvent()
			},
		}

		actions.selectEvent = {
			name: 'Arm Event',
			options: [
				{
					type: 'dropdown',
					label: 'Event',
					id: 'event',
					default: self.CHOICES_EVENTS[0]?.id ?? '',
					choices: self.CHOICES_EVENTS,
				},
			],
			callback: async function (action) {
				await self.selectEvent(action.options)
			},
		}

		actions.increaseDuration = {
			name: 'Armed Duration +',
			options: [
				{
					type: 'textinput',
					label: 'Seconds',
					id: 'duration',
					default: '5',
					useVariables: true,
					tooltip: `Whole seconds to add, 1 to ${self.DURATION_STEP_MAX_S}`,
				},
			],
			callback: async function (action) {
				await self.increaseDuration(action.options)
			},
		}

		actions.decreaseDuration = {
			name: 'Armed Duration -',
			options: [
				{
					type: 'textinput',
					label: 'Seconds',
					id: 'duration',
					default: '5',
					useVariables: true,
					tooltip: `Whole seconds to subtract, 1 to ${self.DURATION_STEP_MAX_S}`,
				},
			],
			callback: async function (action) {
				await self.decreaseDuration(action.options)
			},
		}

		actions.setArmedDuration = {
			name: 'Set Armed Duration',
			options: [
				{
					type: 'textinput',
					label: 'Seconds',
					id: 'seconds',
					default: '60',
					useVariables: true,
					tooltip: `Whole seconds: ${self.DURATION_MIN_S} to ${self.DURATION_MAX_SPLICE_S} (Splice Insert) or ${self.DURATION_MIN_S} to ${self.DURATION_MAX_TIME_SIGNAL_S} (Time Signal)`,
				},
			],
			callback: async function (action) {
				await self.setArmedDuration(action.options)
			},
		}

		self.setActionDefinitions(actions)
	},
}
