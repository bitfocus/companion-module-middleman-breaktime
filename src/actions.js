module.exports = {
	initActions: function () {
		let self = this

		let actions = {}

		actions.startSelected = {
			name: 'Start Selected Event',
			options: [],
			callback: async function (action) {
				self.startSelected()
			},
		}

		actions.endSelected = {
			name: 'End Selected Event',
			options: [],
			callback: async function (action) {
				self.endSelected()
			},
		}

		actions.selectNextEvent = {
			name: 'Select Next Event',
			options: [],
			callback: async function (action) {
				self.selectNextEvent()
			},
		}

		actions.selectPreviousEvent = {
			name: 'Select Previous Event',
			options: [],
			callback: async function (action) {
				self.selectPreviousEvent()
			},
		}

		actions.selectEvent = {
			name: 'Select Event',
			options: [
				{
					type: 'dropdown',
					label: 'Event',
					id: 'event',
					default: self.CHOICES_EVENTS[0].id,
					choices: self.CHOICES_EVENTS,
				},
			],
			callback: async function (action) {
				self.selectEvent(action.options.eventId)
			},
		}

		actions.increaseDuration = {
			name: 'Increase Duration',
			options: [
				{
					type: 'number',
					label: 'Duration',
					id: 'duration',
					default: 5,
					min: 1,
					max: 65535,
					required: true,
				},
			],
			callback: async function (action) {
				self.increaseDuration(action.options.duration)
			},
		}

		actions.decreaseDuration = {
			name: 'Decrease Duration',
			options: [
				{
					type: 'number',
					label: 'Duration',
					id: 'duration',
					default: 5,
					min: 1,
					max: 65535,
					required: true,
				},
			],
			callback: async function (action) {
				self.decreaseDuration(action.options.duration)
			},
		}

		self.setActionDefinitions(actions)
	},
}
