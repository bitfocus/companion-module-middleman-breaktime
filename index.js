const { InstanceBase, InstanceStatus, runEntrypoint } = require('@companion-module/base')

const UpgradeScripts = require('./src/upgrades')

const configFields = require('./src/configFields')
const actions = require('./src/actions')
const feedbacks = require('./src/feedbacks')
const variables = require('./src/variables')
const presets = require('./src/presets')

const defaults = require('./src/defaults')
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
			...defaults,
			...api,
		})
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

		//clear any timeouts
		if (this.WARNING_TIMEOUT) {
			clearTimeout(this.WARNING_TIMEOUT)
		}
	}
}

runEntrypoint(BreakTimeInstance, UpgradeScripts)
