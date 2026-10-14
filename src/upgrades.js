/**
 * @fileoverview Upgrade scripts that migrate stored config, actions and feedbacks
 *
 * Append-only: Companion identifies each script by its array index, so existing
 * scripts are never removed, reordered or changed in behavior.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

module.exports = [
	/**
	 * Upgrade script index 0: a no-op placeholder kept for its position
	 *
	 * @param {import('@companion-module/base').CompanionUpgradeContext} _context - Upgrade context (unused)
	 * @param {import('@companion-module/base').CompanionStaticUpgradeProps} _props - Stored config, actions and
	 *   feedbacks (unused)
	 * @returns {import('@companion-module/base').CompanionStaticUpgradeResult} No changes
	 */
	function (_context, _props) {
		// Placeholder kept for its position: it can no longer be used or removed
		return {
			updatedConfig: null,
			updatedActions: [],
			updatedFeedbacks: [],
		}
	},

	/**
	 * Upgrade script index 1 (module 2.0.0): fills the defaults of options and config fields added in 2.0 and
	 * clears Log Raw BreakTime Data when Verbose Logging is off
	 *
	 * Fills only values that are undefined and never overwrites a stored value, except that
	 * it clears a Log Raw BreakTime Data tick that Verbose Logging no longer backs (see the
	 * config list below). Mutates the received objects and returns only the items it
	 * changed. base 1.13 calls it twice with different shapes: at init with `config` and
	 * `secrets` and empty `actions` and `feedbacks`, then with `config: null, secrets: null`
	 * and the stored entities. Both shapes are handled. Secrets are left alone: the runtime
	 * normalizer treats a missing `apiKey` as ''. No feedback is renamed:
	 * `selectedIsFinished` stays as stored (lead decision), so existing Status buttons look
	 * as they did in 1.0.3.
	 *
	 * - `startSelected`: `event` 'armed', `immediate` false, `onlyWhenIdle` false.
	 * - `endSelected`: `target` 'latest', `immediate` false.
	 * - `increaseDuration` / `decreaseDuration`: a stored number `duration` becomes text
	 *   (the option is now a variable-enabled text field).
	 * - Config: `runningSlots` 4 when undefined.
	 * - Config: `verboseWebsocket` false when it is on and `verbose` is off. 2.0 writes the
	 *   frame dump and shows Log Raw BreakTime Data only while Verbose Logging is on, so a
	 *   hidden tick would otherwise start dumping the moment Verbose Logging is turned on.
	 *   Both flags are read by truthiness, as the frame dump in api.js reads them.
	 *
	 * Both config changes go out in one `updatedConfig`, which is null when neither applied.
	 * Values are literals, not shared constants, so this script's behavior never changes.
	 *
	 * @param {import('@companion-module/base').CompanionUpgradeContext} _context - Upgrade context (unused)
	 * @param {import('@companion-module/base').CompanionStaticUpgradeProps} props - Stored config, actions and feedbacks
	 * @returns {import('@companion-module/base').CompanionStaticUpgradeResult} The changed config (or null) and
	 *   the changed actions
	 */
	function (_context, props) {
		/** Option defaults to fill, per action ID */
		const ACTION_DEFAULTS = {
			startSelected: { event: 'armed', immediate: false, onlyWhenIdle: false },
			endSelected: { target: 'latest', immediate: false },
		}

		const updatedActions = []

		for (const action of props?.actions ?? []) {
			const defaults = Object.hasOwn(ACTION_DEFAULTS, action?.actionId) ? ACTION_DEFAULTS[action.actionId] : null
			const isDuration = action?.actionId === 'increaseDuration' || action?.actionId === 'decreaseDuration'

			if (!defaults && !isDuration) {
				continue
			}

			let changed = false

			if (!action.options || typeof action.options !== 'object') {
				action.options = {}
				changed = true
			}

			if (defaults) {
				for (const key in defaults) {
					if (action.options[key] === undefined) {
						action.options[key] = defaults[key]
						changed = true
					}
				}
			}

			if (isDuration && typeof action.options.duration === 'number') {
				action.options.duration = String(action.options.duration)
				changed = true
			}

			if (changed) {
				updatedActions.push(action)
			}
		}

		let updatedConfig = null
		const config = props?.config

		if (config && typeof config === 'object') {
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
