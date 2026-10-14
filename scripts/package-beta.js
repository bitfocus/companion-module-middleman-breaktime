/**
 * @fileoverview Builds a customer test package whose beta version comes from git
 *
 * Run with `yarn package:beta`, or `yarn package:beta --allow-dirty` to build with
 * uncommitted changes. The version is `<package.json version>-beta.<height>+<commit>`, for
 * example `2.0.0-beta.1+6184928d10`, in the style Nerdbank.GitVersioning gives BreakTime:
 *
 * - The height counts commits: the commit that last changed the package.json "version" is
 *   1, and each commit after it in HEAD's history adds 1.
 * - The commit is the first 10 hex characters of the HEAD commit hash.
 * - Semver ignores the part after "+" when ordering, so betas order by height and every
 *   beta of 2.0.0 sorts below the 2.0.0 release.
 *
 * Merges: the commit that set the version is looked for along HEAD's first-parent line. A
 * merge whose version differs from its first parent's set the version, unless another
 * parent already had that version: then the search goes on down that parent's line. The
 * height then counts every commit in HEAD's history that is not in that commit's history,
 * merged-in commits included.
 *
 * The build tool takes the version only from package.json, so the script writes the beta
 * version there, runs `companion-module-build --prerelease` and then puts the original bytes
 * back, also when the build fails or the script is stopped. `yarn package` is unchanged.
 *
 * `getBetaVersion()` is exported so the version can be worked out without building.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

const { execFileSync, spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** Module folder: the one that holds package.json */
const MODULE_DIR = path.resolve(__dirname, '..')

/** Prerelease name written between the release version and the height */
const CHANNEL = 'beta'

/** Number of hex characters of the HEAD commit hash kept in the version */
const COMMIT_LENGTH = 10

/** Option that builds even when there are uncommitted changes */
const ALLOW_DIRTY_FLAG = '--allow-dirty'

/** Usage line printed for `--help` and for an unknown option */
const USAGE = `Usage: yarn package:beta [${ALLOW_DIRTY_FLAG}]`

/** Most `git status` lines shown in the uncommitted changes error */
const MAX_CHANGE_LINES = 10

/**
 * Signals that stop the build; package.json is put back first. SIGBREAK is Ctrl+Break on Windows: without a
 * handler it ends the process at once, before package.json can be put back.
 */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']

/**
 * Semantic Versioning 2.0.0 pattern from semver.org; group 1 is the release, group 2 the prerelease part and
 * group 3 the build metadata
 */
const SEMVER_PATTERN =
	/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** A full commit hash (SHA-1 or SHA-256) */
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/**
 * A refusal or failure the script reports as a plain message, without a stack trace
 */
class BetaError extends Error {}

/**
 * The beta version for a commit and how it was worked out
 *
 * @typedef {Object} BetaVersion
 * @property {string} version - Full beta version, for example `2.0.0-beta.1+6184928d10`
 * @property {string} release - The package.json "version" it builds on, for example `2.0.0`
 * @property {number} height - Commits since the version was set, counting the commit that set it as 1
 * @property {string} commit - First 10 hex characters of the HEAD commit hash
 * @property {string} setter - First 10 hex characters of the commit that set the version
 * @property {boolean} dirty - True when there are uncommitted changes (only with `allowDirty`)
 */

/**
 * Runs git in a folder and returns its standard output
 *
 * @private
 * @param {string} dir - Folder to run git in
 * @param {string[]} args - git arguments
 * @returns {string} Standard output without trailing whitespace
 * @throws {BetaError} When git is not installed
 * @throws {Error} When git exits with an error
 */
function git(dir, args) {
	try {
		return execFileSync('git', args, {
			cwd: dir,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'pipe'],
		}).trimEnd()
	} catch (err) {
		if (err.code === 'ENOENT') {
			throw new BetaError('git was not found. Install git and make sure it is on the PATH.')
		}

		throw err
	}
}

/**
 * Splits git output into its non-empty lines
 *
 * @private
 * @param {string} output - git output
 * @returns {string[]} One entry per line
 */
function toLines(output) {
	return output.split(/\r?\n/).filter((line) => line !== '')
}

/**
 * Returns the "version" value of package.json text
 *
 * @private
 * @param {string} text - package.json text
 * @returns {string|undefined} The version, or undefined when the text is not JSON or has no string "version"
 */
function parseVersionField(text) {
	try {
		const version = JSON.parse(text).version

		return typeof version === 'string' ? version : undefined
	} catch {
		return undefined
	}
}

/**
 * Returns git's error text, or the error message when git printed none
 *
 * @private
 * @param {Error} err - Error thrown by git()
 * @returns {string} The text, trimmed
 */
function gitErrorText(err) {
	return String(err.stderr || err.message).trim()
}

/**
 * Returns the package.json "version" value in a commit
 *
 * The `./` path is relative to the module folder, so this also works when the module is a subfolder of its
 * repository. Whether the file is there is checked without reading it, so a file that is there but cannot be
 * read (for example a partial clone that cannot reach its remote) stops the script instead of counting as
 * missing, which would give a wrong height.
 *
 * @private
 * @param {string} dir - Module folder
 * @param {string} commit - Commit hash or name
 * @returns {string|undefined} The version, or undefined when the commit has no package.json or no readable
 *   version in it
 * @throws {BetaError} When git cannot tell whether the commit has a package.json, or cannot read it
 */
function committedVersion(dir, commit) {
	const name = commit.slice(0, COMMIT_LENGTH)
	let object

	try {
		object = git(dir, ['rev-parse', '--verify', '--quiet', `${commit}:./package.json`])
	} catch (err) {
		if (err instanceof BetaError) {
			throw err
		}

		// With --quiet, exit code 1 only means the commit has no such file
		if (err.status === 1) {
			return undefined
		}

		throw new BetaError(`Could not look for package.json in commit ${name}: ${gitErrorText(err)}`)
	}

	let text

	try {
		text = git(dir, ['cat-file', 'blob', object])
	} catch (err) {
		if (err instanceof BetaError) {
			throw err
		}

		throw new BetaError(`Could not read package.json from commit ${name}: ${gitErrorText(err)}`)
	}

	return parseVersionField(text)
}

/**
 * Returns the parents of a commit, first parent first
 *
 * @private
 * @param {string} dir - Module folder
 * @param {string} commit - Commit hash
 * @returns {string[]} Parent hashes; empty for a root commit
 */
function parentsOf(dir, commit) {
	return toLines(git(dir, ['rev-parse', `${commit}^@`]))
}

/**
 * Reads the release version from package.json and checks it can take a beta part
 *
 * @private
 * @param {string} dir - Module folder
 * @returns {string} The package.json "version", for example `2.0.0`
 * @throws {BetaError} When package.json cannot be read, or its version is not valid or already has a prerelease
 *   part or build metadata
 */
function readRelease(dir) {
	let text

	try {
		text = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
	} catch (err) {
		throw new BetaError(`Could not read package.json: ${err.message}`)
	}

	const version = parseVersionField(text)

	if (version === undefined) {
		throw new BetaError('Could not read "version" from package.json.')
	}

	const match = SEMVER_PATTERN.exec(version)

	if (!match) {
		throw new BetaError(`package.json "version" is "${version}", which is not a valid version.`)
	}

	if (match[2] !== undefined) {
		throw new BetaError(
			`package.json "version" is "${version}", which already has a prerelease part. ` +
				`Set it to a release version like ${match[1]}. ` +
				'If a beta build was stopped before it could put package.json back, run: git checkout -- package.json',
		)
	}

	if (match[3] !== undefined) {
		throw new BetaError(
			`package.json "version" is "${version}", which already has build metadata. ` +
				`Set it to a release version like ${match[1]}.`,
		)
	}

	return version
}

/**
 * Checks that git can give a full history for the module folder
 *
 * @private
 * @param {string} dir - Module folder
 * @returns {void}
 * @throws {BetaError} When the folder is not in a git work tree, git refuses to open the repository (git's own
 *   reason is kept), the clone is shallow or there is no commit yet
 */
function checkRepository(dir) {
	let inside

	try {
		inside = git(dir, ['rev-parse', '--is-inside-work-tree'])
	} catch (err) {
		if (err instanceof BetaError) {
			throw err
		}

		// Keep git's own reason, for example its safe.directory advice for a folder owned by another account
		if (err.stderr && !/not a git repository/i.test(err.stderr)) {
			throw new BetaError(`git could not open the repository: ${gitErrorText(err)}`)
		}
	}

	if (inside !== 'true') {
		throw new BetaError(
			`${dir} is not in a git repository. Beta builds need the git history to work out the version.`,
		)
	}

	const shallow = git(dir, ['rev-parse', '--is-shallow-repository'])

	if (shallow === 'true') {
		throw new BetaError(
			'This is a shallow clone, so the beta number would be wrong. Get the full history first: git fetch --unshallow',
		)
	}

	if (shallow !== 'false') {
		throw new BetaError('This git is too old to check for a shallow clone. Update git.')
	}

	try {
		git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
	} catch (err) {
		if (err instanceof BetaError) {
			throw err
		}

		throw new BetaError('The repository has no commits yet. Commit the module first.')
	}
}

/**
 * Builds the uncommitted changes error from `git status --porcelain` output
 *
 * @private
 * @param {string} changes - `git status --porcelain` output
 * @returns {string} The message, listing up to MAX_CHANGE_LINES changes
 */
function changesMessage(changes) {
	const lines = toLines(changes)
	const shown = lines.slice(0, MAX_CHANGE_LINES).map((line) => `  ${line}`)

	if (lines.length > MAX_CHANGE_LINES) {
		shown.push(`  and ${lines.length - MAX_CHANGE_LINES} more`)
	}

	return [
		'There are uncommitted changes, so the version would not identify the code in the package:',
		...shown,
		`Commit or stash them, or run with ${ALLOW_DIRTY_FLAG} to build anyway.`,
	].join('\n')
}

/**
 * Finds the commit that set package.json's current "version"
 *
 * Walks the commits on the first-parent line from HEAD that changed package.json, newest first. A commit
 * whose version matches its first parent's only changed something else and is passed over. The first one
 * whose version differs from its first parent's (or whose first parent has no package.json, or that has no
 * parent) set the version, unless it is a merge and another parent already had that version: then the walk
 * goes on down that parent's first-parent line.
 *
 * @private
 * @param {string} dir - Module folder
 * @param {string} version - The version committed at HEAD
 * @returns {string} Full hash of the commit that set the version
 * @throws {BetaError} When the history does not show where the version was set
 */
function findVersionSetter(dir, version) {
	let start = 'HEAD'

	for (;;) {
		// rev-list, not log: settings such as log.showSignature add lines to log's output but not to rev-list's
		const commits = toLines(git(dir, ['rev-list', '--first-parent', start, '--', 'package.json']))
		let source

		for (const commit of commits) {
			// Every version change on this line is listed, so each commit up to the setter has the version
			if (committedVersion(dir, commit) !== version) {
				break
			}

			const parents = parentsOf(dir, commit)

			if (parents.length > 0 && committedVersion(dir, parents[0]) === version) {
				continue
			}

			source = parents.slice(1).find((parent) => committedVersion(dir, parent) === version)

			if (source === undefined) {
				return commit
			}

			break
		}

		if (source === undefined) {
			throw new BetaError(`Could not work out which commit set version ${version} in package.json.`)
		}

		start = source
	}
}

/**
 * Works out the beta version of the commit checked out in a module folder, without building anything
 *
 * @param {string} dir - Module folder (holds package.json); it must be in a git work tree
 * @param {Object} [options] - Options
 * @param {boolean} [options.allowDirty=false] - Allow uncommitted changes instead of refusing
 * @returns {BetaVersion} The version and how it was worked out
 * @throws {BetaError} When the version cannot be worked out or must not be built; the message says why
 */
function getBetaVersion(dir, { allowDirty = false } = {}) {
	const release = readRelease(dir)

	checkRepository(dir)

	// --untracked-files=normal overrides status.showUntrackedFiles=no, which would hide new files
	const changes = git(dir, ['status', '--porcelain', '--untracked-files=normal'])

	if (changes !== '' && !allowDirty) {
		throw new BetaError(changesMessage(changes))
	}

	const committed = committedVersion(dir, 'HEAD')

	if (committed === undefined) {
		throw new BetaError('package.json is not committed yet. Commit it first.')
	}

	if (committed !== release) {
		throw new BetaError(
			`package.json "version" is "${release}" but the committed one is "${committed}". Commit the version change first.`,
		)
	}

	const setter = findVersionSetter(dir, release)
	const height = Number(git(dir, ['rev-list', '--count', `${setter}..HEAD`])) + 1
	const head = git(dir, ['rev-parse', 'HEAD'])

	if (!COMMIT_PATTERN.test(head)) {
		throw new BetaError(`git gave "${head}" as the HEAD commit, which is not a commit hash.`)
	}

	const commit = head.slice(0, COMMIT_LENGTH)
	const version = `${release}-${CHANNEL}.${height}+${commit}`

	if (!Number.isInteger(height) || height < 1 || !SEMVER_PATTERN.test(version)) {
		throw new BetaError(`Worked out "${version}", which is not a valid version.`)
	}

	return {
		version,
		release,
		height,
		commit,
		setter: setter.slice(0, COMMIT_LENGTH),
		dirty: changes !== '',
	}
}

/**
 * Finds the companion-module-build script installed with the module
 *
 * @private
 * @param {string} dir - Module folder
 * @returns {string} Absolute path of the script
 * @throws {BetaError} When @companion-module/tools is not installed
 */
function findBuildTool(dir) {
	try {
		// eslint-disable-next-line n/no-unpublished-require -- a build script, never part of the built package
		const toolsPackage = require.resolve('@companion-module/tools/package.json', { paths: [dir] })
		const bin = JSON.parse(fs.readFileSync(toolsPackage, 'utf8')).bin?.['companion-module-build']

		if (typeof bin !== 'string') {
			throw new Error('it has no companion-module-build entry')
		}

		return path.resolve(path.dirname(toolsPackage), bin)
	} catch (err) {
		throw new BetaError(`Could not find companion-module-build (${err.message}). Run yarn install first.`)
	}
}

/**
 * Returns the path of the .tgz the build tool writes for a version
 *
 * The build tool names it `<manifest id>-<version>.tgz` and turns every character other than letters, digits,
 * "." and "-" into "-" (`toSanitizedDirname()` in @companion-module/tools), so the "+" becomes "-" in the file
 * name only.
 *
 * @private
 * @param {string} dir - Module folder
 * @param {string} version - Version being built
 * @returns {string} Absolute path of the .tgz
 * @throws {BetaError} When companion/manifest.json cannot be read or has no id
 */
function packagePathFor(dir, version) {
	let id

	try {
		id = JSON.parse(fs.readFileSync(path.join(dir, 'companion', 'manifest.json'), 'utf8')).id
	} catch (err) {
		throw new BetaError(`Could not read companion/manifest.json: ${err.message}`)
	}

	if (typeof id !== 'string' || id === '') {
		throw new BetaError('companion/manifest.json has no "id".')
	}

	return path.join(dir, `${`${id}-${version}`.replace(/[^a-zA-Z0-9.-]/g, '-')}.tgz`)
}

/**
 * Runs `companion-module-build --prerelease` with the beta version written into package.json, then puts the
 * original package.json bytes back
 *
 * The bytes go back when the build ends or cannot start, when the script gets SIGINT (Ctrl+C), SIGTERM, SIGHUP
 * or SIGBREAK (Ctrl+Break on Windows; the build is stopped too), and as a last resort when the process exits.
 * They go back only over the beta version the script wrote: when package.json was saved by someone else
 * during the build, it is left alone so that change is not lost. When the bytes are not put back, the script
 * says how to recover and returns 1.
 *
 * @private
 * @param {string} dir - Module folder
 * @param {string} tool - Path of the companion-module-build script
 * @param {BetaVersion} beta - Version to build
 * @param {boolean} packageChanged - True when package.json itself has uncommitted changes, so
 *   `git checkout -- package.json` would lose them
 * @returns {Promise<number>} The build's exit code, 128 plus the signal number when stopped by a signal, or 1
 *   when package.json could not be written or put back
 */
function buildWithVersion(dir, tool, beta, packageChanged) {
	const packagePath = path.join(dir, 'package.json')
	const original = fs.readFileSync(packagePath)
	const betaBytes = Buffer.from(
		`${JSON.stringify({ ...JSON.parse(original.toString('utf8')), version: beta.version }, null, '\t')}\n`,
	)

	return new Promise((resolve) => {
		let modified = false
		// Bytes the script last wrote; null while a write is under way or after one failed
		let written = null
		let changedDuringBuild = false
		let restoreError = null
		let stopSignal = null
		let settled = false
		let child = null

		/**
		 * Writes the original bytes back if package.json still holds what the script wrote
		 *
		 * When it holds anything else, someone saved it during the build, so it is not written and the change
		 * is kept.
		 *
		 * @returns {boolean} True when package.json holds the original bytes
		 */
		const restore = () => {
			if (!modified) {
				return true
			}

			try {
				const current = fs.readFileSync(packagePath)

				if (current.equals(original)) {
					modified = false

					return true
				}

				if (written !== null && !current.equals(written)) {
					changedDuringBuild = true

					throw new Error('package.json was changed while the build ran')
				}

				written = null
				fs.writeFileSync(packagePath, original)
				written = original

				if (!fs.readFileSync(packagePath).equals(original)) {
					throw new Error('it did not read back the same')
				}

				modified = false
			} catch (err) {
				restoreError = err
			}

			return !modified
		}

		/**
		 * Says that package.json was not put back and how to recover
		 *
		 * @returns {void}
		 */
		const printRecovery = () => {
			if (changedDuringBuild) {
				console.error(`Error: ${packagePath} was changed while the build ran, so it was left as it is.`)
				console.error(
					`If its "version" is still ${beta.version}, set it back to "${beta.release}". ` +
						'(git checkout -- package.json would also drop that change.)',
				)

				return
			}

			console.error(
				`Error: could not put back package.json (${restoreError?.message}). It may still have version ${beta.version}.`,
			)
			console.error(
				packageChanged
					? `To recover, set "version" in ${packagePath} back to "${beta.release}". ` +
							'(git checkout -- package.json would also drop your uncommitted changes to it.)'
					: `To recover, run this in ${dir}: git checkout -- package.json`,
			)
		}

		/**
		 * Last resort when the process exits with package.json still changed
		 *
		 * @returns {void}
		 */
		const onExit = () => {
			if (!restore()) {
				printRecovery()
			}
		}

		/**
		 * Puts package.json back and stops the build with SIGTERM; a second signal kills it with SIGKILL
		 *
		 * SIGTERM rather than the signal received, because Windows cannot send SIGHUP to a child process.
		 *
		 * @param {NodeJS.Signals} signal - Signal received
		 * @returns {void}
		 */
		const onSignal = (signal) => {
			restore()

			const firstSignal = stopSignal === null

			stopSignal ??= signal

			try {
				child?.kill(firstSignal ? 'SIGTERM' : 'SIGKILL')
			} catch (err) {
				console.error(`Error: could not stop companion-module-build: ${err.message}`)
			}
		}

		/**
		 * Puts package.json back, removes the handlers and resolves with the exit code, once
		 *
		 * @param {number} code - Exit code when package.json was put back
		 * @returns {void}
		 */
		const finish = (code) => {
			if (settled) {
				return
			}

			settled = true

			for (const signal of STOP_SIGNALS) {
				process.off(signal, onSignal)
			}

			const restored = restore()

			process.off('exit', onExit)

			if (!restored) {
				printRecovery()
			}

			resolve(restored ? code : 1)
		}

		process.on('exit', onExit)

		for (const signal of STOP_SIGNALS) {
			process.on(signal, onSignal)
		}

		try {
			modified = true
			fs.writeFileSync(packagePath, betaBytes)
			written = betaBytes
		} catch (err) {
			console.error(`Error: could not write the beta version into package.json: ${err.message}`)
			finish(1)

			return
		}

		child = spawn(process.execPath, [tool, '--prerelease'], { cwd: dir, stdio: 'inherit' })

		child.on('error', (err) => {
			console.error(`Error: could not start companion-module-build: ${err.message}`)
			finish(1)
		})

		child.on('close', (code, signal) => {
			const endSignal = stopSignal ?? signal

			finish(endSignal ? 128 + (os.constants.signals[endSignal] ?? 0) : (code ?? 1))
		})
	})
}

/**
 * Runs the script: works out the beta version, builds the package and prints a summary
 *
 * @param {string[]} args - Command line arguments after the script name
 * @param {string} [dir=MODULE_DIR] - Module folder to build
 * @returns {Promise<number>} Exit code: the build's own, or 1 when the script refused or failed
 */
async function main(args, dir = MODULE_DIR) {
	if (args.includes('--help') || args.includes('-h')) {
		console.log(USAGE)

		return 0
	}

	const unknown = args.find((arg) => arg !== ALLOW_DIRTY_FLAG)

	if (unknown !== undefined) {
		console.error(`Error: unknown option ${unknown}\n${USAGE}`)

		return 1
	}

	let beta
	let tool
	let file
	let packageChanged

	try {
		beta = getBetaVersion(dir, { allowDirty: args.includes(ALLOW_DIRTY_FLAG) })
		tool = findBuildTool(dir)
		file = packagePathFor(dir, beta.version)
		packageChanged =
			beta.dirty && git(dir, ['status', '--porcelain', '--untracked-files=normal', '--', 'package.json']) !== ''
	} catch (err) {
		// A git command that failed has git's own error text in its message, so it needs no stack trace either
		console.error(err instanceof BetaError || err.stderr !== undefined ? `Error: ${err.message.trim()}` : err)

		return 1
	}

	const dirtyWarning = `Warning: the package contains uncommitted changes, so ${beta.version} does not identify its code exactly.`

	if (beta.dirty) {
		console.warn(dirtyWarning)
	}

	console.log(`Building ${beta.version}`)

	const code = await buildWithVersion(dir, tool, beta, packageChanged)

	if (code !== 0) {
		return code
	}

	if (!fs.existsSync(file)) {
		console.error(`Error: the build finished but ${file} is missing.`)

		return 1
	}

	const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

	console.log('')
	console.log(`Built ${path.basename(file)}`)
	console.log(`  Version: ${beta.version}`)
	console.log(`  Height:  ${beta.height} (${beta.release} was set in ${beta.setter})`)
	console.log(`  File:    ${file}`)
	console.log(`  SHA-256: ${sha256}`)

	try {
		git(dir, ['check-ignore', '--quiet', '--', file])
	} catch {
		console.warn(
			`Warning: git does not ignore ${path.basename(file)}, so the next beta build will see it as a change.`,
		)
	}

	if (beta.dirty) {
		console.warn(dirtyWarning)
	}

	return 0
}

module.exports = { BetaError, getBetaVersion, main }

if (require.main === module) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code
		},
		(err) => {
			console.error(err)
			process.exitCode = 1
		},
	)
}
