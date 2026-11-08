/**
 * @fileoverview Upgrade scripts that migrate stored config, actions and feedbacks
 *
 * Append-only: Companion identifies each script by its array index, so existing
 * scripts are never removed, reordered or changed in behavior.
 *
 * base 2.x stores each action/feedback option value as an `{ isExpression, value }` wrapper
 * rather than a raw value, so index 1 writes defaults in that wrapped shape and converts the
 * stored duration value with the base helper `FixupNumericOrVariablesValueToExpressions`.
 * Config values are not wrapped. Index 0 is base's `EmptyUpgradeScript` (the no-op this slot
 * has always been).
 *
 * No upgrade script is added for the 2.0.2 Armed Duration Seconds change: those fields were
 * `textinput` in the published v2.0.1 and are now `number` fields, but stored text values need
 * no migration. The action and feedback handlers coerce a string value to a number at runtime
 * (via `Number()` / the module's integer parse) and the fields set `allowInvalidValues`, so an
 * existing stored string like "60" still works and an invalid one is refused at press exactly
 * as before.
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
	 * - `increaseDuration` / `decreaseDuration`: the stored `duration` value is run through
	 *   `FixupNumericOrVariablesValueToExpressions`. Option values reach the upgrade as the base 2.x
	 *   `{ isExpression, value }` wrapper, so for a stored number the helper returns a fresh
	 *   `{ isExpression: false, value }` wrapper with the same number (it does not turn a number into
	 *   an expression) and only rewrites a value that holds a variable into an expression. Either way
	 *   it returns a new object, so the action is marked updated while its value and behavior are
	 *   unchanged.
	 * - Config: `runningSlots` 4 when undefined.
	 * - Config: `verboseWebsocket` false when it is on and `verbose` is off.
	 *
	 * Both config changes go out in one `updatedConfig`, which is null when neither applied.
	 * Values are literals, not shared constants, so this script's behavior never changes.
	 *
	 * Tolerates a malformed `props.actions` without throwing: a non-array value is treated as no
	 * actions to upgrade, and null / non-object array elements are skipped before their `actionId`
	 * is read. An upgrade script must never throw, because a throw mutates users' stored configs
	 * (the same rule the `options` guard below follows); base never produces these shapes in normal
	 * host operation, so valid input is migrated exactly as before.
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

		// `props.actions` is typed as an array, but a malformed stored config could hand us a
		// non-array (undefined, an object, ...). Treat anything that is not an array as "no actions
		// to upgrade" instead of letting `for...of` throw: an upgrade script must not throw, because
		// a throw mutates users' stored configs (same reasoning as the `options` guard below).
		const actions: unknown = props.actions
		const actionList: CompanionMigrationAction[] = Array.isArray(actions) ? actions : []

		for (const action of actionList) {
			// Array elements can likewise be null or non-objects in a malformed config, so skip
			// anything that is not a usable action object before reading `actionId`.
			const candidate: unknown = action

			if (!candidate || typeof candidate !== 'object') {
				continue
			}

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
