const { InstanceStatus } = require('@companion-module/base')
const WebSocket = require('ws')

module.exports = {
	initConnection: function () {
		let self = this

		if (self.WS) {
			self.closeConnection() //close any existing connections
		}

		if (self.config.host && self.config.host !== '' && self.config.port && self.config.port !== '') {
			self.WS = new WebSocket(`ws://${self.config.host}:${self.config.port}/api/ws`)

			self.WS.on('error', (error) => {
				console.log(error)
			})

			self.WS.on('open', () => {
				self.updateStatus(InstanceStatus.Ok)
				self.getData()
			})

			self.WS.on('message', (data) => {
				self.processData(data)
			})
		}
	},

	getData: function () {
		//request these commands on startup
		let self = this

		self.checkFeedbacks()
		self.checkVariables()
	},

	processData: function (msg) {
		let self = this

		if (self.config.verboseData) {
			self.log('debug', `Received Data: ${msg}`)
		}

		let data = {}

		try {
			data = JSON.parse(msg)
		} catch (error) {
			self.log('error', `Error parsing JSON from Websocket: ${error}`)
			return
		}

		//check if the list of events has changed - if it has, update the choices for the selectEvent action and rebuild actions
		let events = data.Playlist?.Events || []

		//compare to existing events for differences in event IDs
		let eventIds = events.map((event) => event.ID)

		let existingEventIds = self.DATA.events?.map((event) => event.ID) || []

		self.DATA.events = data.Playlist?.Events || []

		if (
			eventIds.length !== existingEventIds.length ||
			!eventIds.every((id, index) => id === existingEventIds[index])
		) {
			self.CHOICES_EVENTS = self.DATA.events.map((event) => {
				return { id: event.ID, label: event.Name }
			})

			self.initActions()
		}

		self.DATA.selectedEvent = data.NextEvent || {}

		//check if the running event count has changed - if it has, update the variables and feedbacks
		self.DATA.runningEventsCount = data.Playlist?.Events.filter((event) => event.Status == 1).length || 0

		self.DATA.scte104InjectorStatus = data.SCTE104TCPClient?.Connected || false
		self.DATA.vmixStatus = data.vMixTCPClient?.Connected || false

		self.checkFeedbacks()
		self.checkVariables()
	},

	startSelected: function () {
		let self = this

		if (!self.DATA.selectedEvent) {
			self.issueWarning('No Event Selected.', 2000)
			return
		}

		self.sendREST(`/api/events/${self.DATA.selectedEvent.ID}/start`, 'POST')
	},

	endSelected: function () {
		let self = this

		if (!self.DATA.selectedEvent) {
			self.issueWarning('No Event Selected.', 2000)
			return
		}

		self.sendREST(`/api/events/${self.DATA.selectedEvent.ID}/end`, 'POST')
	},

	selectNextEvent: function () {
		let self = this

		//get the next event id from self.DATA.events based on the one after the currently selected event
		//if the currently selected event is the last one, select the first one

		if (self.DATA.events.length > 0) {
			let nextEventID = self.DATA.events[0].ID

			if (self.DATA.selectedEvent) {
				let currentIndex = self.DATA.events.findIndex((event) => event.ID === self.DATA.selectedEvent.ID)
				if (currentIndex < self.DATA.events.length - 1) {
					nextEventID = self.DATA.events[currentIndex + 1].ID
					self.sendREST('/api/set-next-event', 'POST', { nextEventID: nextEventID })
				}
			}
		} else {
			self.issueWarning('No Events Found.', 2000)
		}
	},

	selectPreviousEvent: function () {
		let self = this

		//get the previous event id from self.DATA.events based on the one before the currently selected event
		//if the currently selected event is the first one, select the last one

		if (self.DATA.events.length > 0) {
			let previousEventID = self.DATA.events[self.DATA.events.length - 1].ID

			if (self.DATA.selectedEvent) {
				let currentIndex = self.DATA.events.findIndex((event) => event.ID === self.DATA.selectedEvent.ID)
				if (currentIndex > 0) {
					previousEventID = self.DATA.events[currentIndex - 1].ID
					self.sendREST('/api/set-next-event', 'POST', { nextEventID: previousEventID })
				}
			}
		} else {
			self.issueWarning('No Events Found.', 2000)
		}
	},

	selectEvent: function (eventID) {
		let self = this

		//make sure this is a valid event id
		if (!self.DATA.events.find((event) => event.ID === eventID)) {
			self.issueWarning('Invalid Event ID.', 2000)
			return
		}

		self.sendREST(`/api/set-next-event`, 'POST', { nextEventID: eventID })
	},

	increaseDuration: function (duration) {
		let self = this

		let selectedEvent = self.DATA.selectedEvent

		//only send if the duration mode is DOWN (DurationMode = 0), otherwise issue a warning
		if (selectedEvent.DurationMode !== 0) {
			self.issueWarning('Cannot change Duration when in COUNT UP Mode.', 2000)
			return
		}

		//don't let the duration go higher than the limit
		//when the message mode is Splice Insert, the max is 6553
		//when the message mode is Time Signal, the max is 65535

		if (duration > 65535) {
			duration = 65535
		}

		if (selectedEvent.MessageMode == 0 && duration > 6553) {
			duration = 6553
		}

		selectedEvent = { ...selectedEvent, DurationSeconds: duration }

		self.sendREST(`/api/events/${self.DATA.selectedEvent.ID}`, 'POST', selectedEvent)
	},

	decreaseDuration: function (duration) {
		let self = this

		let selectedEvent = self.DATA.selectedEvent

		//only send if the duration mode is DOWN (DurationMode = 0), otherwise issue a warning
		if (selectedEvent.DurationMode !== 0) {
			self.issueWarning('Cannot change Duration when in COUNT UP Mode.', 2000)
			return
		}

		//don't let the duration go lower than 1
		if (duration < 1) {
			duration = 1
		}

		selectedEvent = { ...selectedEvent, DurationSeconds: duration }
		self.sendREST(`/api/events/${self.DATA.selectedEvent.ID}`, 'POST', selectedEvent)
	},

	issueWarning: function (message, duration = 5000) {
		let self = this

		self.log('warn', message)

		self.DATA.message = message
		self.DATA.temporaryWarning = true

		self.checkFeedbacks('temporaryWarning')
		self.checkVariables()

		//clear the warning after 5 seconds
		setTimeout(() => {
			self.DATA.message = ''
			self.DATA.temporaryWarning = false

			self.checkFeedbacks('temporaryWarning')
			self.checkVariables()
		}, duration)
	},

	closeConnection: function () {
		let self = this

		//close out the websocket
		if (self.WS) {
			self.log('info', 'Closing Websocket Connection.')
			self.WS.close()
			self.WS = undefined
			delete self.WS
		}
	},

	sendWSCommand: function (command) {
		let self = this

		try {
			if (self.WS) {
				if (self.config.verbose) {
					self.log('debug', `Sending Command: ${command}`)
				}
				try {
					self.WS.send(command)
					self.lastCommand = command
				} catch (error) {
					self.log('error', 'Error sending command: ' + String(error))
				}
			} else {
				self.log('warn', 'Websocket not connected. Command not sent.')
			}
		} catch (error) {
			self.log('error', `WS Error: ${error}`)
		}
	},

	sendREST: function (path, method = 'GET', body = undefined) {
		let self = this

		try {
			let url = `http://${self.config.host}:${self.config.port}${path}`

			let options = {
				method: method,
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
			}

			if (body) {
				options.body = new URLSearchParams(Object.entries(body)).toString()
			}

			if (self.config.verbose) {
				self.log('debug', `Sending REST Command: ${method} ${url} ${body ? JSON.stringify(body) : ''}`)
			}

			fetch(url, options)
				.then((response) => {
					if (response.ok) {
						//console.log(response.json())
					} else {
						self.log('error', `HTTP Error: ${response.status}`)
					}
				})
				.then((data) => {
					self.log('info', `REST Response: ${JSON.stringify(data)}`)
				})
				.catch((error) => {
					self.log('error', `REST Error: ${error}`)
				})
		} catch (error) {
			self.log('error', `REST Error: ${error}`)
		}
	},

	convertTime: function (ms, format) {
		//converts milliseconds to a time format like seconds, minutes:seconds, or hours:minutes:seconds
		let self = this

		//make sure it's a number
		ms = Number(ms)

		let seconds = Math.abs(Math.ceil(ms / 1000))
		let minutes = Math.abs(Math.floor(seconds / 60))
		let hours = Math.abs(Math.floor(minutes / 60))

		if (format === 'ss') {
			return seconds
		} else if (format === 'mm:ss') {
			return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
		} else if (format === 'hh:mm:ss') {
			return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
		} else {
			return ms //some unsupported format
		}
	},
}
