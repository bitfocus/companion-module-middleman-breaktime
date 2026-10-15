/**
 * @fileoverview Build settings read by companion-module-build
 *
 * Copies THIRD-PARTY-NOTICES.txt and the licenses/ folder into the package root, so the
 * notices ship with the module. The LICENSE file the build writes leaves out code copied
 * inside dependencies and has no text for @companion-module/base 1.13.6. Only extraFiles is
 * set, so the bundled main.js is the same as without this file.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

module.exports = {
	extraFiles: ['THIRD-PARTY-NOTICES.txt', 'licenses'],
}
