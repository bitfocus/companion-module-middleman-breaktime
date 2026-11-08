/**
 * @fileoverview Action definitions for the BreakTime module
 *
 * Each callback awaits its handler in api.ts, so Companion's action call resolves only
 * after BreakTime answered (or REST_TIMEOUT_MS passed). The exception is an arm press made
 * while another arm request is in flight: it is folded into the next request and returns
 * at once (see `armEvent()` in api.ts). Handlers never throw, and each one receives the
 * raw `action.options`: an option missing from a button created before it existed (or
 * from a preset) is treated as its definition default by the handler.
 *
 * Stored action IDs are unchanged from 1.0.3; only the display names changed
 * ("Selected" is now "Armed", matching the BreakTime UI).
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

import type { CompanionActionDefinitions, CompanionInputFieldCheckbox } from '@companion-module/base'
import type { BreakTimeInstanceTypes } from './main.js'
import type BreakTimeInstance from './main.js'

export const actions = {
	/**
	 * Registers every action definition with Companion
	 *
	 * Expensive: call at init and only again when a definition or its choices change
	 * (the event list, see `processData`).
	 *
	 * @returns void
	 */
	initActions(): void {
		const self: BreakTimeInstance = this

		// The precise actions manifest makes every entry's keys required, so start from an asserted
		// empty object and populate it below (one entry per action id).
		const actions = {} as CompanionActionDefinitions<BreakTimeInstanceTypes['actions']>

		const immediateOption: CompanionInputFieldCheckbox<'immediate'> = {
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
					// Keep a stored event id that is no longer in the live playlist: 2.x rejects a
					// dropdown value not in `choices`, and the callback already tolerates an unknown id
					allowCustom: true,
					tooltip:
						"Which event to start. 'Armed event' starts whatever is currently armed (same as the Start Armed Event action); choose a specific event to make this button always start that one.",
				},
				immediateOption,
				{
					type: 'checkbox',
					label: 'Only when no event is running',
					id: 'onlyWhenIdle',
					default: false,
					tooltip:
						'Only start when nothing is already running. Stops this button starting a second event while one is already running.',
				},
			],
			callback: async (action, context) => {
				await self.startSelected(action.options, context.signal)
			},
		}

		actions.startArmed = {
			name: 'Start Armed Event',
			options: [immediateOption],
			callback: async (action, context) => {
				await self.startArmed(action.options, context.signal)
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
					disableAutoExpression: true,
					tooltip:
						'Which running event(s) to end: the latest to start, all running events, or a specific event chosen below.',
				},
				{
					type: 'dropdown',
					label: 'Event',
					id: 'event',
					default: self.CHOICES_EVENTS[0]?.id ?? '',
					choices: self.CHOICES_EVENTS,
					// Keep a stored event id that is no longer in the live playlist: 2.x rejects a
					// dropdown value not in `choices`, and the callback already tolerates an unknown id
					allowCustom: true,
					isVisibleExpression: "$(options:target) == 'specific'",
					tooltip: 'The event to end. Only used when Target is set to a specific event.',
				},
				immediateOption,
			],
			callback: async (action, context) => {
				await self.endSelected(action.options, context.signal)
			},
		}

		actions.selectNextEvent = {
			name: 'Arm Next',
			options: [],
			callback: async (_action, context) => {
				await self.selectNextEvent(context.signal)
			},
		}

		actions.selectPreviousEvent = {
			name: 'Arm Previous',
			options: [],
			callback: async (_action, context) => {
				await self.selectPreviousEvent(context.signal)
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
					// Keep a stored event id that is no longer in the live playlist: 2.x rejects a
					// dropdown value not in `choices`, and the callback already tolerates an unknown id
					allowCustom: true,
					tooltip:
						'The event to arm. The armed event is what Start Armed Event fires and what the armed readouts show.',
				},
			],
			callback: async (action, context) => {
				await self.selectEvent(action.options, context.signal)
			},
		}

		actions.increaseDuration = {
			name: 'Armed Duration +',
			options: [
				{
					type: 'number',
					label: 'Seconds',
					id: 'duration',
					default: 5,
					min: 1,
					max: self.DURATION_STEP_MAX_S,
					asInteger: true,
					// Pass an out-of-range/non-integer expression value through to the handler's own
					// validate-and-warn path instead of letting base silently skip the action
					allowInvalidValues: true,
					tooltip: `Whole seconds to add, 1 to ${self.DURATION_STEP_MAX_S}`,
				},
			],
			callback: async (action, context) => {
				await self.increaseDuration(action.options, context.signal)
			},
		}

		actions.decreaseDuration = {
			name: 'Armed Duration -',
			options: [
				{
					type: 'number',
					label: 'Seconds',
					id: 'duration',
					default: 5,
					min: 1,
					max: self.DURATION_STEP_MAX_S,
					asInteger: true,
					// Pass an out-of-range/non-integer expression value through to the handler's own
					// validate-and-warn path instead of letting base silently skip the action
					allowInvalidValues: true,
					tooltip: `Whole seconds to subtract, 1 to ${self.DURATION_STEP_MAX_S}`,
				},
			],
			callback: async (action, context) => {
				await self.decreaseDuration(action.options, context.signal)
			},
		}

		actions.setArmedDuration = {
			name: 'Set Armed Duration',
			options: [
				{
					type: 'number',
					label: 'Seconds',
					id: 'seconds',
					default: 60,
					min: self.DURATION_MIN_S,
					max: self.DURATION_MAX_TIME_SIGNAL_S,
					asInteger: true,
					// A single field max cannot express the mode-specific limit (6553 Splice / 65535 Time
					// Signal), so pass the value through to setArmedDuration's own validation and warning
					allowInvalidValues: true,
					tooltip: `Whole seconds: ${self.DURATION_MIN_S} to ${self.DURATION_MAX_SPLICE_S} (Splice Insert) or ${self.DURATION_MIN_S} to ${self.DURATION_MAX_TIME_SIGNAL_S} (Time Signal)`,
				},
			],
			callback: async (action, context) => {
				await self.setArmedDuration(action.options, context.signal)
			},
		}

		self.setActionDefinitions(actions)
	},
} satisfies ThisType<BreakTimeInstance>

/** The shape the `actions` methods add to the module class */
export type ActionsMixin = typeof actions
