module.exports = {
	WS: undefined, //websocket connection to camera

	WARNING_TIMEOUT: undefined, //timeout for warning messages

	DATA: {
		//data object to store variables
		runningEventsCount: 0,
		events: [],
		selectedEvent: undefined,
		scte104InjectorStatus: false,
		vmixStatus: false,
		message: '',
		temporaryWarning: false,
	},

	CHOICES_EVENTS: [{ id: '0', label: 'Loading Events...' }], //choices for the selectEvent action, this will be replaced with actual data when it is received

	CHOICES_DURATION_MODES: [
		//choices for the feedbacks related to duration mode
		{ id: '1', label: 'Count Up' },
		{ id: '0', label: 'Count Down' },
	],

	CHOICES_WARNINGS: [
		//choices for the warnings
		{ id: 'event', label: 'Event Related' },
		{ id: 'increaseDuration', label: 'Increase Duration Not Allowed' },
		{ id: 'decreaseDuration', label: 'Decrease Duration Not Allowed' },
		{ id: 'scte104', label: 'SCTE 104 Injector Status' },
		{ id: 'vmix', label: 'VMix Connectivity Status' },
	],
}
