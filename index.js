const { InstanceBase, InstanceStatus, runEntrypoint } = require('@companion-module/base')

const UpgradeScripts = require('./src/upgrades')

const configFields = require('./src/configFields')
const actions = require('./src/actions')
const feedbacks = require('./src/feedbacks')
const variables = require('./src/variables')
const presets = require('./src/presets')

const constants = require('./src/constants')
const api = require('./src/api')

class BreakTimeInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		// Assign the methods from the listed files to this class
		Object.assign(this, {
			...configFields,
			...actions,
			...feedbacks,
			...variables,
			...presets,
			...constants,
			...api,
		})

		this.WS = undefined //websocket connection to camera
		this.INTERVAL = undefined //interval for polling data

		this.DATA = {
			runningEventsCount: 0,
			events: [],
			selectedEvent: undefined,
			scte104InjectorStatus: false,
			vmixStatus: false,
			message: '',
			temporaryWarning: false,
		}
	}

	async init(config) {
		this.configUpdated(config)
	}

	async configUpdated(config) {
		if (config) {
			this.config = config
		}

		this.updateStatus(InstanceStatus.Connecting)

		this.initActions()
		this.initFeedbacks()
		this.initVariables()
		this.initPresets()

		this.checkFeedbacks()
		this.checkVariables()

		this.initConnection()
	}

	async destroy() {
		//close out any connections
		this.closeConnection()
	}
}

runEntrypoint(BreakTimeInstance, UpgradeScripts)
