const { InstanceStatus } = require('@companion-module/base')
const WebSocket = require('ws')

module.exports = {
	initConnection: function () {
		//initialize the websocket connection
		let self = this

		if (self.WS) {
			self.closeConnection() //close any existing connections
		}

		if (self.config.host && self.config.host !== '' && self.config.port && self.config.port !== '') {
			self.log('info', `Connecting to Websocket at ws://${self.config.host}:${self.config.port}/api/ws`)
			self.WS = new WebSocket(`ws://${self.config.host}:${self.config.port}/api/ws`)

			self.WS.on('error', (error) => {
				self.log('error', 'Websocket Error: ' + error.toString())
				self.updateStatus(InstanceStatus.ConnectionFailure)
			})

			self.WS.on('open', () => {
				self.log('info', 'Websocket Connected.')
				self.updateStatus(InstanceStatus.Ok)
			})

			self.WS.on('message', (data) => {
				self.processData(data)
			})
		}
	},

	processData: function (msg) {
		//process data from the websocket
		let self = this

		if (self.config.verboseWebsocket) {
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
		let events = data.Playlist?.Events || [] //get the events list

		if (self.config.verboseWebsocket) {
			self.log('debug', `Received ${events.length} Events.`)
		}

		//compare to existing events for differences in event IDs
		let eventIds = events.map((event) => event.ID) //get the new event IDs
		let existingEventIds = self.DATA.events?.map((event) => event.ID) || [] //get the existing event IDs

		self.DATA.events = data.Playlist?.Events || [] //update the events list

		if (
			eventIds.length !== existingEventIds.length ||
			!eventIds.every((id, index) => id === existingEventIds[index])
		) {
			if (self.config.verbose) {
				self.log('debug', 'Events List Changed. Updating Choices.')
			}

			self.CHOICES_EVENTS = self.DATA.events.map((event) => {
				return { id: event.ID, label: event.Name }
			})

			self.initActions()
		}

		if (self.config.verboseWebsocket) {
			self.log('debug', `Selected Event: ${data.NextEvent?.Name} (${data.NextEvent?.ID})`)
		}

		self.DATA.selectedEvent = data.NextEvent || {} //update the selected event

		//grab the old running count value
		let oldRunningEventsCount = self.DATA.runningEventsCount

		//update the running count
		self.DATA.runningEventsCount = data.Playlist?.Events.filter((event) => event.Status == 1).length || 0 //count the number of events with a status of 1 (running)

		if (self.config.verbose && oldRunningEventsCount !== self.DATA.runningEventsCount) {
			//only log if it has changed
			self.log('debug', `Running Events: ${self.DATA.runningEventsCount}`)
		}

		//check if SCTE104 Injector Status has gone from true to false, and issue a warning if so
		if (self.DATA.scte104InjectorStatus && !data.SCTE104TCPClient?.Connected) {
			self.issueWarning('scte104', 'SCTE104 Injector has disconnected.', 5000)
		}

		self.DATA.scte104InjectorStatus = data.SCTE104TCPClient?.Connected || false //update the SCTE104 Injector status

		//get the SCTE104 Splice Event ID and Segmentation Event ID
		self.DATA.scte104SpliceEventID = data.SCTE104TCPClient?.SpliceEventID || ''
		self.DATA.scte104SegmentationEventID = data.SCTE104TCPClient?.SegmentationEventID || ''

		//check if vMix Status has gone from true to false, and issue a warning if so
		if (self.DATA.vmixStatus && !data.vMixTCPClient?.Connected) {
			self.issueWarning('vmix', 'vMix has disconnected.', 5000)
		}

		self.DATA.vmixStatus = data.vMixTCPClient?.Connected || false //update the vMix status

		self.checkFeedbacks()
		self.checkVariables()
	},

	startSelected: function () {
		//start the selected event
		let self = this

		if (!self.DATA.selectedEvent) {
			self.issueWarning('event', 'No Event Selected.', 2000)
			return
		}

		if (self.config.verbose) {
			self.log('debug', `Starting Event: ${self.DATA.selectedEvent.Name} (${self.DATA.selectedEvent.ID})`)
		}

		self.sendREST(`/api/events/${self.DATA.selectedEvent.ID}/start`, 'POST')
	},

	endSelected: function () {
		//end the selected event
		let self = this

		if (!self.DATA.selectedEvent) {
			self.issueWarning('event', 'No Event Selected.', 2000)
			return
		}

		if (self.config.verbose) {
			self.log('debug', `Ending Event: ${self.DATA.selectedEvent.Name} (${self.DATA.selectedEvent.ID})`)
		}

		self.sendREST(`/api/events/${self.DATA.selectedEvent.ID}/end`, 'POST')
	},

	selectNextEvent: function () {
		//select the next event in the Events list
		let self = this

		//get the next event id from self.DATA.events based on the one after the currently selected event
		//if the currently selected event is the last one, select the first one

		if (self.DATA.events.length > 0) {
			let nextEventID = self.DATA.events[0].ID

			if (self.DATA.selectedEvent) {
				let currentIndex = self.DATA.events.findIndex((event) => event.ID === self.DATA.selectedEvent.ID)
				if (currentIndex < self.DATA.events.length - 1) {
					nextEventID = self.DATA.events[currentIndex + 1].ID

					if (self.config.verbose) {
						//get event name by id
						let nextEventName = self.DATA.events.find((event) => event.ID === nextEventID).Name
						self.log('debug', `Selecting Next Event: ${nextEventName} (${nextEventID})`)
					}

					self.sendREST('/api/set-next-event', 'POST', { nextEventID: nextEventID })
				}
			}
		} else {
			self.issueWarning('event', 'No Events Found.', 2000)
		}
	},

	selectPreviousEvent: function () {
		//select the previous event in the Events list
		let self = this

		//get the previous event id from self.DATA.events based on the one before the currently selected event
		//if the currently selected event is the first one, select the last one

		if (self.DATA.events.length > 0) {
			let previousEventID = self.DATA.events[self.DATA.events.length - 1].ID

			if (self.DATA.selectedEvent) {
				let currentIndex = self.DATA.events.findIndex((event) => event.ID === self.DATA.selectedEvent.ID)
				if (currentIndex > 0) {
					previousEventID = self.DATA.events[currentIndex - 1].ID

					if (self.config.verbose) {
						//get event name by id
						let previousEventName = self.DATA.events.find((event) => event.ID === previousEventID).Name
						self.log('debug', `Selecting Previous Event: ${previousEventName} (${previousEventID})`)
					}

					self.sendREST('/api/set-next-event', 'POST', { nextEventID: previousEventID })
				}
			}
		} else {
			self.issueWarning('event', 'No Events Found.', 2000)
		}
	},

	selectEvent: function (eventID) {
		//select a specific event by ID
		let self = this

		//make sure this is a valid event id
		if (!self.DATA.events.find((event) => event.ID === eventID)) {
			self.issueWarning('event', 'Invalid Event ID.', 2000)
			return
		}

		//get event name by id
		let eventName = self.DATA.events.find((event) => event.ID === eventID).Name

		if (self.config.verbose) {
			self.log('debug', `Selecting Event: ${eventName} (${eventID})`)
		}

		self.sendREST(`/api/set-next-event`, 'POST', { nextEventID: eventID })
	},

	increaseDuration: function (duration) {
		//increase the duration of the selected event by the amount specified (in seconds)
		let self = this

		let selectedEvent = self.DATA.selectedEvent

		//only send if the duration mode is DOWN (DurationMode = 0), otherwise issue a warning
		if (selectedEvent?.DurationMode !== 0) {
			self.issueWarning('increaseDuration', 'Cannot change Duration when in COUNT UP Mode.', 2000)
			return
		}

		//don't let the duration go higher than the limit
		//when the message mode is Splice Insert, the max is 6553
		//when the message mode is Time Signal, the max is 65535

		let newDuration = selectedEvent.DurationSeconds + duration

		if (newDuration > 65535) {
			//Time Signal
			newDuration = 65535
		}

		if (selectedEvent.MessageMode == 0 && newDuration > 6553) {
			//Splice Insert
			newDuration = 6553
		}

		selectedEvent.DurationSeconds = newDuration

		if (self.config.verbose) {
			self.log(
				'debug',
				`Increasing ${selectedEvent.Name} Duration by ${duration}. New Duration: ${selectedEvent.DurationSeconds}`,
			)
		}

		self.sendREST(`/api/events/${self.DATA.selectedEvent.ID}`, 'POST', selectedEvent)
	},

	decreaseDuration: function (duration) {
		//decrease the duration of the selected event by the amount specified (in seconds)
		let self = this

		let selectedEvent = self.DATA.selectedEvent

		//only send if the duration mode is DOWN (DurationMode = 0), otherwise issue a warning
		if (selectedEvent?.DurationMode !== 0) {
			self.issueWarning('decreaseDuration', 'Cannot change Duration when in COUNT UP Mode.', 2000)
			return
		}

		let newDuration = selectedEvent.DurationSeconds - duration

		//don't let the duration go lower than 1
		if (newDuration < 1) {
			newDuration = 1
		}

		selectedEvent.DurationSeconds = newDuration

		if (self.config.verbose) {
			self.log(
				'debug',
				`Decreasing ${selectedEvent.Name} Duration by ${duration}. New Duration: ${selectedEvent.DurationSeconds}`,
			)
		}

		self.sendREST(`/api/events/${self.DATA.selectedEvent.ID}`, 'POST', selectedEvent)
	},

	issueWarning: function (type, message, duration = 5000) {
		//issue a warning message that will display on the Companion UI for a specified duration
		let self = this

		self.log('warn', message)

		self.DATA.message = message
		self.DATA.temporaryWarning = true
		self.DATA.temporaryWarningType = type

		self.checkFeedbacks('temporaryWarning')
		self.checkVariables()

		//clear the warning after 5 seconds
		self.WARNING_TIMEOUT = setTimeout(() => {
			self.DATA.message = ''
			self.DATA.temporaryWarning = false
			self.DATA.temporaryWarningType = undefined

			self.checkFeedbacks('temporaryWarning')
			self.checkVariables()

			self.WARNING_TIMEOUT = undefined
		}, duration)
	},

	closeConnection: function () {
		//close the websocket connection
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
		//send a command to the websocket
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
		//send a REST command to the server
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
					if (self.config.verbose) {
						//self.log('info', `REST Response: ${JSON.stringify(data)}`)
					}
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
