/**
 * @fileoverview Upgrade scripts that migrate stored config, actions and feedbacks
 *
 * Append-only: Companion identifies each script by its array index, so existing
 * scripts are never removed, reordered or changed in behavior.
 *
 * base 2.x stores each action/feedback option value as an `{ isExpression, value }` wrapper
 * rather than a raw value, so index 1 writes defaults in that wrapped shape and converts the
 * duration text field with the base helper `FixupNumericOrVariablesValueToExpressions`.
 * Config values are not wrapped. Index 0 is base's `EmptyUpgradeScript` (the no-op this slot
 * has always been).
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

import { EmptyUpgradeScript, FixupNumericOrVariablesValueToExpressions } from '@companion-module/base'

import type {
	CompanionMigrationAction,
	CompanionStaticUpgradeProps,
	CompanionStaticUpgradeResult,
	CompanionStaticUpgradeScript,
	CompanionUpgradeContext,
	JsonValue,
} from '@companion-module/base'
import type { Config, Secrets } from './main.js'

export const UpgradeScripts: CompanionStaticUpgradeScript<Config, Secrets>[] = [
	// Index 0: a no-op placeholder kept for its position; it can no longer be used or removed
	EmptyUpgradeScript,

	/**
	 * Index 1 (module 2.0.0): fills the defaults of options and config fields added in 2.0 and
	 * clears Log Raw BreakTime Data when Verbose Logging is off
	 *
	 * Fills only option values that are missing (undefined) and never overwrites a stored
	 * value, except that it clears a Log Raw BreakTime Data tick that Verbose Logging no
	 * longer backs. Mutates the received objects and returns only the items it changed. Option
	 * values are the base 2.x `{ isExpression, value }` wrapper; config values are raw.
	 *
	 * - `startSelected`: `event` 'armed', `immediate` false, `onlyWhenIdle` false.
	 * - `endSelected`: `target` 'latest', `immediate` false.
	 * - `increaseDuration` / `decreaseDuration`: the `duration` field (now variable-enabled
	 *   text) is normalized by `FixupNumericOrVariablesValueToExpressions`, which turns a
	 *   stored number into the expression format while preserving its behavior.
	 * - Config: `runningSlots` 4 when undefined.
	 * - Config: `verboseWebsocket` false when it is on and `verbose` is off.
	 *
	 * Both config changes go out in one `updatedConfig`, which is null when neither applied.
	 * Values are literals, not shared constants, so this script's behavior never changes.
	 *
	 * @param _context - Upgrade context (unused)
	 * @param props - Stored config, actions and feedbacks
	 * @returns The changed config (or null) and the changed actions
	 */
	function (
		_context: CompanionUpgradeContext<Config>,
		props: CompanionStaticUpgradeProps<Config, Secrets>,
	): CompanionStaticUpgradeResult<Config, Secrets> {
		/** Option defaults to fill, per action ID */
		const ACTION_DEFAULTS: Record<string, Record<string, JsonValue>> = {
			startSelected: { event: 'armed', immediate: false, onlyWhenIdle: false },
			endSelected: { target: 'latest', immediate: false },
		}

		const updatedActions: CompanionMigrationAction[] = []

		for (const action of props.actions) {
			const defaults = Object.hasOwn(ACTION_DEFAULTS, action.actionId) ? ACTION_DEFAULTS[action.actionId] : null
			const isDuration = action.actionId === 'increaseDuration' || action.actionId === 'decreaseDuration'

			if (!defaults && !isDuration) {
				continue
			}

			let changed = false

			// Stored actions can predate the typed option shape, so guard against a missing or
			// non-object `options` before touching it: without this, a stored action whose
			// `options` is absent or not an object would throw a TypeError out of this upgrade,
			// which mutates users' stored configs.
			const options: unknown = action.options

			if (!options || typeof options !== 'object') {
				action.options = {}
				changed = true
			}

			if (defaults) {
				for (const key in defaults) {
					if (action.options[key] === undefined) {
						action.options[key] = { isExpression: false, value: defaults[key] }
						changed = true
					}
				}
			}

			if (isDuration) {
				const fixed = FixupNumericOrVariablesValueToExpressions(action.options.duration)

				if (fixed !== action.options.duration) {
					action.options.duration = fixed
					changed = true
				}
			}

			if (changed) {
				updatedActions.push(action)
			}
		}

		let updatedConfig: Config | null = null
		const config = props.config

		if (config) {
			let changed = false

			if (config.runningSlots === undefined) {
				config.runningSlots = 4
				changed = true
			}

			if (config.verboseWebsocket && !config.verbose) {
				config.verboseWebsocket = false
				changed = true
			}

			if (changed) {
				updatedConfig = config
			}
		}

		return {
			updatedConfig: updatedConfig,
			updatedActions: updatedActions,
			updatedFeedbacks: [],
		}
	},
]
