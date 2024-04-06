const { combineRgb } = require('@companion-module/base')

module.exports = {
	initFeedbacks() {
		let self = this
		const feedbacks = {}

		const foregroundColor = combineRgb(255, 255, 255) // White
		const backgroundColorRed = combineRgb(255, 0, 0) // Red
		const backgroundColorGreen = combineRgb(0, 255, 0) // Green
		const backgroundColorBlue = combineRgb(0, 0, 255) // Blue
		const backgroundColorGray = combineRgb(125, 125, 125) // Gray

		feedbacks.selectedIsRunning = {
			type: 'boolean',
			name: 'Selected Event is Running',
			description: 'If the selected event is running, change the color of the button.',
			defaultStyle: {
				color: foregroundColor,
				bgcolor: backgroundColorRed,
			},
			options: [],
			callback: async function (feedback) {
				if (self.DATA.selectedEvent?.Status == 1) {
					return true
				}

				return false
			},
		}

		feedbacks.selectedisFinished = {
			type: 'boolean',
			name: 'Selected Event is Stopped/Finished',
			description: 'If the selected event has finished, change the color of the button.',
			defaultStyle: {
				color: foregroundColor,
				bgcolor: backgroundColorRed,
			},
			options: [],
			callback: async function (feedback) {
				if (self.DATA.selectedEvent?.Status == 0) {
					return true
				}

				return false
			},
		}

		feedbacks.selectedDurationMode = {
			type: 'boolean',
			name: 'Selected Event Duration Mode',
			description: 'If the selected event is in a specific mode, change the color of the button.',
			defaultStyle: {
				color: foregroundColor,
				bgcolor: backgroundColorRed,
			},
			options: [
				{
					type: 'dropdown',
					label: 'Mode',
					id: 'mode',
					choices: self.CHOICES_DURATION_MODES,
					default: self.CHOICES_DURATION_MODES[0].id,
				},
			],
			callback: async function (feedback, bank) {
				if (self.DATA.selectedEvent?.DurationMode === feedback.options.mode) {
					return true
				}

				return false
			},
		}

		feedbacks.IncDecNotAllowed = {
			type: 'boolean',
			name: 'Increase/Decrease Not Allowed',
			description:
				'If incrementing or decrementing the selected event is not allowed, change the color of the button.',
			defaultStyle: {
				color: foregroundColor,
				bgcolor: backgroundColorGray,
			},
			options: [],
			callback: async function (feedback) {
				if (self.DATA.selectedEvent?.DurationMode !== 0) {
					return true
				}

				return false
			},
		}

		feedbacks.vMixConnected = {
			type: 'boolean',
			name: 'vMix Connected',
			description: 'If vMix is connected, change the color of the button.',
			defaultStyle: {
				color: foregroundColor,
				bgcolor: backgroundColorGreen,
			},
			options: [],
			callback: async function (feedback) {
				if (self.DATA.vMixConnected == true) {
					return true
				}

				return false
			},
		}

		feedbacks.vMixDisconnected = {
			type: 'boolean',
			name: 'vMix Disconnected',
			description: 'If vMix is disconnected, change the color of the button.',
			defaultStyle: {
				color: foregroundColor,
				bgcolor: backgroundColorRed,
			},
			options: [],
			callback: async function (feedback) {
				if (self.DATA.vMixConnected == false) {
					return true
				}

				return false
			},
		}

		feedbacks.scte104Connected = {
			type: 'boolean',
			name: 'SCTE-104 Injector Connected',
			description: 'If the SCTE-104 Injector is connected, change the color of the button.',
			defaultStyle: {
				color: foregroundColor,
				bgcolor: backgroundColorGreen,
			},
			options: [],
			callback: async function (feedback) {
				if (self.DATA.scte104InjectorStatus == true) {
					return true
				}

				return false
			},
		}

		feedbacks.scte104Disconnected = {
			type: 'boolean',
			name: 'SCTE-104 Injector Disconnected',
			description: 'If the SCTE-104 Injector is disconnected, change the color of the button.',
			defaultStyle: {
				color: foregroundColor,
				bgcolor: backgroundColorRed,
			},
			options: [],
			callback: async function (feedback) {
				if (self.DATA.scte104InjectorStatus == false) {
					return true
				}

				return false
			},
		}

		feedbacks.temporaryWarning = {
			type: 'boolean',
			name: 'Temporary Warning',
			description: 'If there is a temporary warning, change the color of the button.',
			defaultStyle: {
				color: foregroundColor,
				bgcolor: backgroundColorRed,
			},
			options: [
				{
					type: 'dropdown',
					label: 'Warning Type',
					id: 'warning',
					choices: self.CHOICES_WARNINGS,
					default: self.CHOICES_WARNINGS[0].id,
				},
			],
			callback: async function (feedback) {
				if (self.DATA.temporaryWarning == true && self.DATA.temporaryWarningType == feedback.options.warning) {
					return true
				}

				return false
			},
		}

		self.setFeedbackDefinitions(feedbacks)
	},
}
