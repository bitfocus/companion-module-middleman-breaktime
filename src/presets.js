const { combineRgb } = require('@companion-module/base')

module.exports = {
	initPresets: function () {
		let self = this

		let presets = {}

		presets['Start'] = {
			type: 'button',
			category: 'Event Controls',
			name: 'Start Selected Event',
			style: {
				size: '18',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: 'Start',
			},
			steps: [
				{
					down: [
						{
							actionId: 'startSelected',
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}

		presets['End'] = {
			type: 'button',
			category: 'Event Controls',
			name: 'End Selected Event',
			style: {
				size: '18',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: 'End',
			},
			steps: [
				{
					down: [
						{
							actionId: 'endSelected',
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}

		presets['Next'] = {
			type: 'button',
			category: 'Event Controls',
			name: 'Select Next Event',
			style: {
				size: '18',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: 'Next',
			},
			steps: [
				{
					down: [
						{
							actionId: 'selectNextEvent',
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}

		presets['Previous'] = {
			type: 'button',
			category: 'Event Controls',
			name: 'Select Previous Event',
			style: {
				size: '18',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: 'Previous',
			},
			steps: [
				{
					down: [
						{
							actionId: 'selectPreviousEvent',
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}

		presets['Increase'] = {
			type: 'button',
			category: 'Duration Controls',
			name: 'Increase Duration 1 Second',
			style: {
				size: '18',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: '+1s',
			},
			steps: [
				{
					down: [
						{
							actionId: 'increaseDuration',
							options: {
								duration: 1,
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'IncDecNotAllowed',
					options: {},
					style: {
						bgcolor: combineRgb(125, 125, 125),
					},
				},
				{
					feedbackId: 'temporaryWarning',
					options: {},
					style: {
						bgcolor: combineRgb(255, 0, 0),
					},
				},
			],
		}

		presets['Decrease'] = {
			type: 'button',
			category: 'Duration Controls',
			name: 'Decrease Duration 1 Second',
			style: {
				size: '18',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: '-1s',
			},
			steps: [
				{
					down: [
						{
							actionId: 'decreaseDuration',
							options: {
								duration: 1,
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [
				{
					feedbackId: 'IncDecNotAllowed',
					options: {},
					style: {
						bgcolor: combineRgb(125, 125, 125),
					},
				},
				{
					feedbackId: 'temporaryWarning',
					options: {},
					style: {
						bgcolor: combineRgb(255, 0, 0),
					},
				},
			],
		}

		presets['RunningEventsCount'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'Running Events Count',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: '$(breaktime:running_events_count)',
			},
			steps: [],
			feedbacks: [],
		}

		presets['SelectedName'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'Selected Event Name',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: '$(breaktime:selected_name)',
			},
			steps: [],
			feedbacks: [],
		}

		presets['SelectedStatus'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'Selected Event Status',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: '$(breaktime:selected_status)',
			},
			steps: [],
			feedbacks: [
				{
					feedbackId: 'selectedIsRunning',
					options: {},
					style: {
						bgcolor: combineRgb(0, 255, 0),
					},
				},
				{
					feedbackId: 'selectedHasFinished',
					options: {},
					style: {
						bgcolor: combineRgb(255, 0, 0),
					},
				},
			],
		}

		presets['SelectedDuration'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'Selected Event Duration',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: '$(breaktime:selected_duration)',
			},
			steps: [],
			feedbacks: [],
		}

		presets['SelectedTime'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'Selected Event Time Remaining/Elapsed',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: '$(breaktime:selected_time)',
			},
			steps: [],
			feedbacks: [],
		}

		presets['SelectedDurationMode'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'Selected Event Duration Mode',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: '$(breaktime:selected_duration_mode)',
			},
			steps: [],
			feedbacks: [
				{
					feedbackId: 'selectedDurationMode',
					options: {
						mode: '0',
					},
					style: {
						bgcolor: combineRgb(0, 255, 0),
					},
				},
				{
					feedbackId: 'selectedDurationMode',
					options: {
						mode: '1',
					},
					style: {
						bgcolor: combineRgb(255, 0, 0),
					},
				},
			],
		}

		presets['Scte104InjectorStatusBool'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'SCTE 104 Injector Status Bool',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: 'SCTE104: $(breaktime:scte104_injector_status_bool)',
			},
			steps: [],
			feedbacks: [],
		}

		presets['Scte104InjectorStatus'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'SCTE 104 Injector Status',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: 'SCTE104: $(breaktime:scte104_injector_status)',
			},
			steps: [],
			feedbacks: [],
		}

		presets['VmixStatusBool'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'VMix Connectivity Status Bool',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: 'VMix: $(breaktime:vmix_status_bool)',
			},
			steps: [],
			feedbacks: [],
		}

		presets['VmixStatus'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'VMix Connectivity Status',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: 'VMix: $(breaktime:vmix_status)',
			},
			steps: [],
			feedbacks: [],
		}

		presets['Message'] = {
			type: 'button',
			category: 'Info/Variables',
			name: 'Current Message',
			style: {
				size: '14',
				color: combineRgb(255, 255, 255),
				bgcolor: combineRgb(0, 0, 0),
				text: '$(breaktime:message)',
			},
			steps: [],
			feedbacks: [],
		}

		self.setPresetDefinitions(presets)
	},
}
