/**
 * @fileoverview Connection config fields shown in the Companion web UI
 *
 * The API key is a `secret-text` field, so Companion stores it in the secrets store
 * rather than the config store. Field validation here is a UI hint only: index.js
 * normalizes and clamps every value before use. Host and Port are always shown; the
 * other settings show only while Show Advanced Settings is on.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

const { Regex } = require('@companion-module/base')

module.exports = {
	/**
	 * Returns the config field definitions for the connection settings form
	 *
	 * Called by Companion whenever it renders the form. `Regex.HOSTNAME` also accepts
	 * IPv4 addresses, so host values saved by 1.0.3 stay valid. Port uses the module's own
	 * `PORT_REGEX` (1 to 65535, leading zeros allowed) instead of `Regex.PORT`, which stops
	 * at 65534; index.js checks the stored port with the same pattern.
	 *
	 * Layout on the 12-column grid, where fields flow left to right and wrap to a new row
	 * when the next one would pass 12: Information; a divider; Host (8) and Port (4); a
	 * second divider, so Show Advanced Settings does not sit tight under Host and Port;
	 * Show Advanced Settings (12). With it on: API Key (12, since keys are long); Running
	 * Event Slots (4) plus an empty static-text filler (8) with the same visibility, so no
	 * other field joins its row; Verbose Logging (6) and Log Raw BreakTime Data (6), wide
	 * enough that a narrow panel does not wrap the help icon under the label. Static-text
	 * fields hold no saved value, so the dividers and the filler add nothing to the config.
	 *
	 * `showAdvanced` only drives the `isVisibleExpression` of the fields after it: the
	 * module never reads it, and index.js leaves it out of the settings it compares, so
	 * saving it alone keeps the connection and logs nothing. A config saved by 1.0.3 has no
	 * `showAdvanced`; Companion evaluates the missing value as false, so those fields start
	 * hidden. Hiding a field keeps its saved value in effect (a hidden API key stays in
	 * use), which is also why the frame dump in api.js still checks both logging flags
	 * although Log Raw BreakTime Data shows only while Verbose Logging is on.
	 *
	 * @returns {import('@companion-module/base').SomeCompanionConfigField[]} Config field definitions
	 */
	getConfigFields() {
		let self = this

		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: `This module controls Middleman Software's BreakTime, version 2.0 or later. For BreakTime 1.x, use version 1.0.3 of this module. For more information, visit <a href="https://middleman.tv" target="_new">https://middleman.tv</a>.`,
			},
			{
				type: 'static-text',
				id: 'hr',
				width: 12,
				label: '',
				value: '<hr />',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Host',
				tooltip: 'IP address or hostname of the BreakTime server',
				width: 8,
				regex: Regex.HOSTNAME,
				default: '127.0.0.1',
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Port',
				tooltip: "BreakTime's web port. The default is 5165.",
				width: 4,
				regex: self.PORT_REGEX,
				default: '5165',
			},
			{
				type: 'static-text',
				id: 'hrAdvanced',
				width: 12,
				label: '',
				value: '<hr />',
			},
			{
				type: 'checkbox',
				id: 'showAdvanced',
				label: 'Show Advanced Settings',
				width: 12,
				default: false,
			},
			{
				type: 'secret-text',
				id: 'apiKey',
				label: 'API Key',
				tooltip: 'Only needed when BreakTime security is on',
				width: 12,
				default: '',
				isVisibleExpression: '$(options:showAdvanced)',
			},
			{
				type: 'number',
				id: 'runningSlots',
				label: 'Running Event Slots',
				tooltip:
					'How many running events get their own variables and Running Slot buttons. An event keeps its slot until it ends.',
				width: 4,
				default: self.DEFAULT_RUNNING_SLOTS,
				min: 1,
				max: self.MAX_RUNNING_SLOTS,
				isVisibleExpression: '$(options:showAdvanced)',
			},
			{
				type: 'static-text',
				id: 'runningSlotsFiller',
				width: 8,
				label: '',
				value: '',
				isVisibleExpression: '$(options:showAdvanced)',
			},
			{
				type: 'checkbox',
				id: 'verbose',
				label: 'Verbose Logging',
				tooltip:
					'Adds detailed lines to the log, such as each request sent to BreakTime and playlist changes. For troubleshooting only; turn it off for normal use.',
				width: 6,
				default: false,
				isVisibleExpression: '$(options:showAdvanced)',
			},
			{
				type: 'checkbox',
				id: 'verboseWebsocket',
				label: 'Log Raw BreakTime Data',
				tooltip:
					'Writes every update from BreakTime to the log, about once a second. For troubleshooting only.',
				width: 6,
				default: false,
				isVisibleExpression: '$(options:showAdvanced) && $(options:verbose)',
			},
		]
	},
}
