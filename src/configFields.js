const { Regex } = require('@companion-module/base')

module.exports = {
	getConfigFields() {
		let self = this

		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value: `This module controls Middleman Software's BreakTime.`,
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
				label: 'IP Address',
				width: 6,
				regex: Regex.IP,
				default: '127.0.0.1',
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Port',
				width: 6,
				regex: Regex.Port,
				default: '5165',
			},
			{
				type: 'static-text',
				id: 'hr',
				width: 12,
				label: '',
				value: '<hr />',
			},
			{
				type: 'checkbox',
				id: 'verbose',
				label: 'Verbose Logging',
				width: 3,
				default: false,
			},
			{
				type: 'static-text',
				id: 'info-verbose',
				width: 9,
				label: 'Enable verbose logging for debugging purposes.',
			},
			{
				type: 'checkbox',
				id: 'verbose',
				label: 'Verbose Logging - Websocket Data',
				width: 3,
				default: false,
			},
			{
				type: 'static-text',
				id: 'info-verbose',
				width: 9,
				label: 'Enable verbose logging of all Websocket Data for debugging purposes.',
			},
		]
	},
}
