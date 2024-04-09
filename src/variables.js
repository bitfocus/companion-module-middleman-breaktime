module.exports = {
	initVariables: function () {
		let self = this

		let variables = []

		variables.push({ variableId: 'running_events_count', name: 'Running Events Count' })

		variables.push({ variableId: 'selected_name', name: 'Selected Event Name' })
		variables.push({ variableId: 'selected_status', name: 'Selected Event Status' })

		variables.push({ variableId: 'selected_duration_ss', name: 'Selected Event Duration (SS)' })
		variables.push({ variableId: 'selected_duration_mmss', name: 'Selected Event Duration (MM:SS)' })
		variables.push({ variableId: 'selected_duration_hhmmss', name: 'Selected Event Duration (HH:MM:SS)' })

		variables.push({ variableId: 'selected_time_ss', name: 'Selected Event Time Remaining/Elapsed (SS)' })
		variables.push({ variableId: 'selected_time_mmss', name: 'Selected Event Time Remaining/Elapsed (MM:SS)' })
		variables.push({ variableId: 'selected_time_hhmmss', name: 'Selected Event Time Remaining/Elapsed (HH:MM:SS)' })

		variables.push({ variableId: 'selected_duration_mode', name: 'Selected Event Duration Mode' })

		variables.push({ variableId: 'scte104_injector_status_bool', name: 'SCTE 104 Injector Status Bool' })
		variables.push({ variableId: 'scte104_injector_status', name: 'SCTE 104 Injector Status' })
		variables.push({ variableId: 'scte104_splice_event_id', name: 'SCTE 104 Splice Event ID' })
		variables.push({ variableId: 'scte104_segmentation_event_id', name: 'SCTE 104 Segmentation Event ID' })

		variables.push({ variableId: 'vmix_status_bool', name: 'VMix Connectivity Status Bool' })
		variables.push({ variableId: 'vmix_status', name: 'VMix Connectivity Status' })

		variables.push({ variableId: 'message', name: 'Current Message' })
		variables.push({ variableId: 'warning', name: 'Temporary Warning Activated' })

		self.setVariableDefinitions(variables)
	},

	checkVariables: function () {
		let self = this

		try {
			let variableValues = {}

			variableValues['running_events_count'] = self.DATA.runningEventsCount

			if (!self.DATA.selectedEvent) {
				variableValues['selected_name'] = 'No Event Selected'
				variableValues['selected_status'] = ''

				variableValues['selected_duration_ss'] = ''
				variableValues['selected_duration_mmss'] = ''
				variableValues['selected_duration_hhmmss'] = ''

				variableValues['selected_time_ss'] = ''
				variableValues['selected_time_mmss'] = ''
				variableValues['selected_time_hhmmss'] = ''

				variableValues['selected_duration_mode'] = ''
				variableValues['scte104_injector_status_bool'] = ''
				variableValues['scte104_injector_status'] = ''
				variableValues['vmix_status_bool'] = ''
				variableValues['vmix_status'] = ''
				variableValues['message'] = ''
				variableValues['warning'] = ''
			} else {
				variableValues['selected_name'] = self.DATA.selectedEvent?.Name || ''
				variableValues['selected_status'] = self.DATA.selectedEvent?.Status == 1 ? 'Running' : 'Stopped' || ''

				if (self.DATA.selectedEvent?.DurationSeconds == 0) {
					variableValues['selected_duration_ss'] = ''
					variableValues['selected_duration_mmss'] = ''
					variableValues['selected_duration_hhmmss'] = ''
				} else {
					variableValues['selected_duration_ss'] =
						self.convertTime(self.DATA.selectedEvent?.DurationSeconds * 1000, 'ss') || '' //the function expects it in ms
					variableValues['selected_duration_mmss'] =
						self.convertTime(self.DATA.selectedEvent?.DurationSeconds * 1000, 'mm:ss') || ''
					variableValues['selected_duration_hhmmss'] =
						self.convertTime(self.DATA.selectedEvent?.DurationSeconds * 1000, 'hh:mm:ss') || ''
				}

				if (self.DATA.selectedEvent?.DurationMode == 0) {
					// Countdown
					variableValues['selected_time_ss'] =
						self.convertTime(self.DATA.selectedEvent?.RemainingSeconds * 1000, 'ss') || ''
					variableValues['selected_time_mmss'] =
						self.convertTime(self.DATA.selectedEvent?.RemainingSeconds * 1000, 'mm:ss') || ''
					variableValues['selected_time_hhmmss'] =
						self.convertTime(self.DATA.selectedEvent?.RemainingSeconds * 1000, 'hh:mm:ss') || ''
				} else {
					// Elapsed
					variableValues['selected_time_ss'] =
						self.convertTime(self.DATA.selectedEvent?.ElapsedSeconds * 1000, 'ss') || ''
					variableValues['selected_time_mmss'] =
						self.convertTime(self.DATA.selectedEvent?.ElapsedSeconds * 1000, 'mm:ss') || ''
					variableValues['selected_time_hhmmss'] =
						self.convertTime(self.DATA.selectedEvent?.ElapsedSeconds * 1000, 'hh:mm:ss') || ''
				}

				variableValues['selected_duration_mode'] =
					self.DATA.selectedEvent?.DurationMode == 0 ? 'Count Down' : 'Count Up' || ''

				variableValues['scte104_injector_status_bool'] = self.DATA.scte104InjectorStatus ? 'True' : 'False'
				variableValues['scte104_injector_status'] = self.DATA.scte104InjectorStatus
					? 'Connected'
					: 'Disconnected'

				variableValues['scte104_splice_event_id'] = self.DATA.scte104SpliceEventID
				variableValues['scte104_segmentation_event_id'] = self.DATA.scte104SegmentationEventID

				variableValues['vmix_status_bool'] = self.DATA.vmixStatus ? 'True' : 'False'
				variableValues['vmix_status'] = self.DATA.vmixStatus ? 'Connected' : 'Disconnected'

				variableValues['message'] = self.DATA.message
				variableValues['warning'] = self.DATA.temporaryWarning ? 'True' : 'False'
			}

			self.setVariableValues(variableValues)
		} catch (error) {
			self.log('error', 'Error setting Variables: ' + String(error))
			console.log(error)
		}
	},
}
