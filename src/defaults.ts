/**
 * @fileoverview Constants, choice lists, shared colors, the START running-state frame image and the default data factory
 *
 * The constant values are gathered into the `defaults` mixin object and spread onto the
 * module class in the constructor, so every one is also readable as `this.<NAME>`. The
 * other files also import the named exports they use at module level. Holds no per-instance
 * state: the constructor owns that, and `createDefaultData()` returns a fresh state object
 * each time it is called. The other shared functions are `formatClock()`, shared by the tile
 * text and the Set Duration preset labels, and `literalButtonText()`, which keeps an event name
 * literal on a button; `readModuleVersion()` is a private load-time helper for MODULE_VERSION.
 *
 * @module companion-module-middleman-breaktime
 * @see {@link https://github.com/bitfocus/companion-module-middleman-breaktime}
 */

import { createRequire } from 'node:module'
import { combineRgb } from '@companion-module/base'

import type { BreakTimeEvent, HaState } from './api.js'

/** Reported as the version when neither package.json layout can be read; a sentinel, never a real release */
const UNKNOWN_VERSION = '0.0.0'

/**
 * Reads this module's own version from its package.json in either bundle layout, without ever throwing
 *
 * `createRequire(import.meta.url)` resolves relative to the running bundle, whose location differs
 * between the two ways this module ships, so the correct relative path to package.json differs too:
 * - Packaged .tgz: the esbuild bundle is `main.js` at the package root, with the built package.json
 *   beside it, so `./package.json` is correct. (`../package.json` would point above the module folder
 *   and throw — the crash this helper exists to prevent.)
 * - Dev `dist/` build: `tsc` emits `dist/defaults.js`, so the repo's own package.json is one level up
 *   at `../package.json`.
 *
 * Each candidate is required in its own try/catch so a miss falls through to the next, and only a
 * non-empty string `version` is accepted (so a resolved but version-less package.json also falls
 * through rather than returning `undefined`). The whole body is wrapped too, so even the unreachable
 * case of `createRequire` throwing on a non-file module URL cannot escape: if nothing resolves it
 * returns {@link UNKNOWN_VERSION}. This runs at module-eval time, where any throw would kill the whole
 * module process on load — unacceptable in a 24/7 broadcast host.
 *
 * @returns The `version` from the first package.json that resolves, or {@link UNKNOWN_VERSION} if none does
 */
function readModuleVersion(): string {
	try {
		const require = createRequire(import.meta.url)

		// The correct relative path to package.json depends on the bundle layout (see above): the packaged
		// .tgz has it beside main.js (`./`), the dev dist/ build one level up (`../`). Try both in order.
		for (const candidate of ['./package.json', '../package.json']) {
			try {
				const version = (require(candidate) as { version?: unknown }).version

				if (typeof version === 'string' && version.length > 0) {
					return version
				}
			} catch {
				// Not this layout, or unreadable here; try the next candidate
			}
		}
	} catch {
		// Belt and braces: any unexpected failure (e.g. createRequire on a non-file URL) falls back below
	}

	return UNKNOWN_VERSION
}

/** This module's version, from its package.json; sent in the config log line and the User-Agent */
export const MODULE_VERSION: string = readModuleVersion()

/**
 * Per-connection BreakTime state cache, normalized from each state frame by `processData()`
 *
 * While the WebSocket is down (`handleDisconnect()`), `events` and `selectedEvent` keep only
 * `ID` and `Name`, `running` is empty, `runningEventsCount` is '', both connectivity
 * buckets and every component read `Unknown`, `ha` is null and `haRoleAlarm` is null.
 * `componentsSeen`, `haSeen`, `eventNames` and `slotByEventId` survive a disconnect: they
 * are log baselines, a name memory and the running slot assignments, reset only with the
 * whole object on a host or port change (`eventNames` is also pruned whenever the event
 * choices are rebuilt). While the WebSocket is down every entry of `slotEvents` is empty,
 * so the slot variables read blank, and the assignments wait for the first frame after
 * reconnect: an event still running then keeps its slot.
 */
export interface BreakTimeData {
	/** `Playlist.Events` from the last frame, in playlist order */
	events: BreakTimeEvent[]
	/**
	 * The armed event: the playlist's own entry whose `ID` matches `NextEvent.ID`, or undefined when nothing
	 * (or a deleted event) is armed
	 */
	selectedEvent: BreakTimeEvent | undefined
	/** Running events (`Status` 1), newest first by `StartMS`, ties in playlist order; `running[0]` is the latest */
	running: BreakTimeEvent[]
	/** Number of running events; '' while the WebSocket is down */
	runningEventsCount: number | ''
	/**
	 * Fixed running slot (1..runningSlots) of each running event that holds one, keyed by event ID; an event keeps
	 * its slot until it stops running (`assignRunningSlots()` in api.ts)
	 */
	slotByEventId: Map<string, number>
	/**
	 * The running event in each slot (index 0 is slot 1), undefined for an empty slot; one entry per configured
	 * slot, refilled in place on every frame
	 */
	slotEvents: Array<BreakTimeEvent | undefined>
	/** SCTE 104 bucket: Connected when the Client or the Server is Healthy, Disabled when both are Disabled */
	scte104Status: ConnectivityBucket
	/** vMix bucket: Healthy is Connected, Disabled is Disabled, anything else Disconnected */
	vmixStatus: ConnectivityBucket
	/** Status of every known component, keyed by slug (see COMPONENTS) */
	components: Record<string, ComponentState>
	/** Last component status seen in a frame, keyed by slug; the `state: component changed` baseline */
	componentsSeen: Record<string, ComponentStatusName>
	/** The frame's `HA` object as received (its enum values are strings), or null while the WebSocket is down */
	ha: HaState | null
	/** HA values from the last frame; the `state: ha changed` baseline, null before the first frame */
	haSeen: HaSeen | null
	/** The frame's `HARoleAlarm`, or null when none (and while the WebSocket is down) */
	haRoleAlarm: string | null
	/**
	 * Name of every event in the playlist, plus every removed event an `eventTile` still shows, so a removed
	 * event's tile can still name it; pruned to those when the event choices are rebuilt
	 */
	eventNames: Map<string, string>
	/** Text of the active timed warning, '' when none; `message` shows it while the warning is active */
	warningText: string
	/** True while a timed warning is active */
	temporaryWarning: boolean
	/** Warning type ID of the active warning */
	temporaryWarningType: string | undefined
	/** Splice event ID of `LastStartedEvent` (Splice Insert only); '' for none or 0 */
	scte104SpliceEventID: string | number
	/** Segmentation event ID of `LastStartedEvent` (Time Signal only); '' for none or 0 */
	scte104SegmentationEventID: string | number
	/** Raw `GET /api/version` string (including `+sha`), '' until known */
	breaktimeVersion: string
	/** BreakTime security state, '' until known */
	breaktimeSecurity: '' | 'On' | 'Off'
}

/** Connectivity bucket shown by the legacy SCTE 104 and vMix variables and feedbacks */
export type ConnectivityBucket = 'Connected' | 'Disconnected' | 'Disabled' | 'Unknown'

/** Component status name; BreakTime's `Status` 0-3 by name, or Unknown when the key is missing or the WebSocket is down */
export type ComponentStatusName = 'Disabled' | 'Unhealthy' | 'Warning' | 'Healthy' | 'Unknown'

/** One component's status as shown by the `component_<slug>` variables */
export interface ComponentState {
	/** Status name */
	status: ComponentStatusName
	/** BreakTime's `StatusDetail`, '' when unknown */
	detail: string
}

/** HA values the `state: ha changed` line compares between frames */
export interface HaSeen {
	/** `HA.Role` */
	role: string | undefined
	/** `HA.Acting` */
	acting: boolean | undefined
	/** `HA.LinkState` */
	link: string | undefined
	/** `HARoleAlarm` */
	alarm: string | null
}

/** A `{id, label}` choice for a dropdown field */
export interface Choice {
	id: string
	label: string
}

/**
 * Button colors shared by the feedback styles and the presets
 *
 * Tally meaning: red while running (or a fault), amber armed and ready, dark gray idle, green
 * connected (or the current value), gray not allowed now, muted gray with dimmed text for
 * an event no longer in the playlist.
 */
export const COLORS = Object.freeze({
	/** White text */
	WHITE: combineRgb(255, 255, 255),

	/** Black background or text */
	BLACK: combineRgb(0, 0, 0),

	/** Red background: running, or a fault */
	RED: combineRgb(255, 0, 0),

	/** Green background: connected, or the current value */
	GREEN: combineRgb(0, 255, 0),

	/** Gray background: an action that is not allowed now */
	GRAY: combineRgb(125, 125, 125),

	/** Muted gray background: an event no longer in the playlist; dark enough for DIM_TEXT to stay readable */
	REMOVED_GRAY: combineRgb(64, 64, 64),

	/** Amber background: armed and ready */
	AMBER: combineRgb(255, 160, 0),

	/** Dark gray background: idle */
	DARK_GRAY: combineRgb(40, 40, 40),

	/** Dimmed text on a dark background */
	DIM_TEXT: combineRgb(150, 150, 150),
})

/** BreakTime component keys (`ComponentStatuses`) and the slugs used in variable IDs and options */
export const COMPONENTS: ReadonlyArray<{ key: string; slug: string }> = Object.freeze([
	Object.freeze({ key: 'Stream Injector', slug: 'stream_injector' }),
	Object.freeze({ key: 'SDI Injector', slug: 'sdi_injector' }),
	Object.freeze({ key: 'SCTE 104 Client', slug: 'scte104_client' }),
	Object.freeze({ key: 'SCTE 104 Server', slug: 'scte104_server' }),
	Object.freeze({ key: 'Captions', slug: 'captions' }),
	Object.freeze({ key: 'Zixi', slug: 'zixi' }),
	Object.freeze({ key: 'vMix', slug: 'vmix' }),
	Object.freeze({ key: 'AvailX TX', slug: 'availx_tx' }),
	Object.freeze({ key: 'Stream Health', slug: 'stream_health' }),
])

/**
 * Zero-width space (U+200B), written as an escape so it stays visible in the source
 *
 * `literalButtonText()` puts it inside `$(` and a backslash escape so Companion shows them as
 * typed. Never type the raw character here: it is invisible in an editor and a diff.
 */
const ZERO_WIDTH_SPACE = '​'

/**
 * Static preset glyph images, as base64 PNG data with no `data:` prefix, encoded once for the preset blocks
 *
 * Each is 288 x 288 px, 8-bit RGBA (PNG color type 6): a single monochrome glyph on a fully transparent
 * background. 288 px is the shared glyph canvas, drawn 1:1 at a 72 px key (x4) and a 144 px
 * preview (x2). Generated once by a
 * scratch Node script (built-ins only: `node:zlib` plus a local CRC32; shapes rasterized at 2x and
 * box-downsampled with alpha-weighted colour averaging, so edges anti-alias with no dark fringe), never edited
 * by hand and never re-encoded at runtime.
 *
 * The presets draw each as `png64` with `pngalignment: 'center:top'` and put the word label in `text` with
 * `alignment: 'center:bottom'`. Because Companion scales a `png64` to fill the whole key — `pngalignment`
 * only bites when the image letterboxes — each glyph is rasterized into the
 * top ~half of the 288 canvas with the lower band left fully transparent, so it maps onto the top of the key
 * above the label with a clear gap rather than behind it. Colour is fixed per glyph to contrast its button:
 * {@link PLAY_PNG64} is dark for the amber START/Start-specific blocks; every other glyph is white, legible
 * on both the dark-gray idle fill and the red running fill.
 */
export const PLAY_PNG64 =
	'iVBORw0KGgoAAAANSUhEUgAAASAAAAEgCAYAAAAUg66AAAACuElEQVR42u3dsQ2DQBREwV+aS6MzSrMTAhKEo110zEjbgIMX3J3FDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA3/aZ+fgZgIbvMSECagESIqAeoHOINj8P0AjQeUIE1AIkREA9QEIE1AMkREA9QEIE1AMkREA9QN4SAfUACRFQD5AQAfUACRFQD5AQAfUACRFQD5A/voIAPWpCBAIkRMB7AyREIEBCBAiQEIEACREgQN4SgQAJESBAQgQCJESAAAkRCJAQAQIkRCBA3hIBAiREIEBCBAJkQgQCJEQgQCZEIECPC5ErfBAgb4lAgIRIiECAhAgESIiECARIiECAhEiIQIC8JQIBMiECARIiECATIgTIhAgEyIQIATJ/fAUBMm+JECATIhAgEyIEyAQIBEh4QIDMtTwIkPCAAJnwgAAJDwiQXR4sCw8CZG60QICEBwTIhAcESHhAgMyNFgiQ8IAAmfCAAAkPCJCDZUCAhAcESHgAARIeECCfwwEEyI0WCJDwACM8gAAJDwiQGy1AgIQHBEh4AAESHhAgB8uAAAkPCJDwAG8JkPCAAPl6KLB2gNxogQAJD7B+gIQHBEh4gPUD5GAZEB5g/QAJDxAPkPAA0QA5WAbiARIeIB4g4QHiARIeIB4gXw8F4gFyowXEAyQ8QDxAwgPEAyQ8QDRAbrSAOOEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAODWD2+6edho+C2IAAAAAElFTkSuQmCC'

export const STOP_PNG64 =
	'iVBORw0KGgoAAAANSUhEUgAAASAAAAEgCAYAAAAUg66AAAACL0lEQVR42u3UMQ0AAAzDsPInvUHoNWmHjSFKAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAMbymUAwIAwIDMiAwIAwIDMiAwIAwIDAgAwIDwoDAgAwIDAgDAgMyIDAgDAgMyIDAgDAgDAgDAgPCgDAgDAgMyIDAgDAgMCADAgPCgMCADAgMCAMCAzIgMCAMCAzIgMCAMCAwIAMCA8KAMCAMCAwIA8KAMCAwIAwIA8KAwIAMCAwIAwIDMiAwIAwIDMiAwIAwIDAgAwIDwoDAgAwIDAgDAgMyIDAgDAgDwoDAgDAgDAgDAgMyIDAgDAgMyIDAgDAgMCADAgPCgMCADAgMCAMCAzIgMCAMCAzIgMCAMCAMCAMCA8KAMCAMCAwIA8KAMCAwIAMCA8KAwIAMCAwIAwIDMiAwIAwIDMiAwIAwIDAgAwIDwoDAgAwIDAgDwoAwIDAgDAgDwoDAgAwIDAgDAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgxAKqZGD7DoVHVgAAAABJRU5ErkJggg=='

export const BOLT_PNG64 =
	'iVBORw0KGgoAAAANSUhEUgAAASAAAAEgCAYAAAAUg66AAAADEElEQVR42u3c23ECMRQFQUJTaJuZQpOdgDHv2V26Q9DH1D0UcLkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDprLXmum56JaCIz/JKQBKftdbwUkARH9MLSOJjegFNfH77s3ktoIiP6QUk8fHBM5DFx/QCkviYXkASH9MLyOJjegFJfEwvIImP6QVk8TG9gCQ+pheQxMf0ArL4uH6Ah8Mz1hO8IJDEx/QCqviYXkASH9MLaOJjegFVfEwvIImP6QU08TG9gCo+pheQxMf1A2Tx8Ut3IImP6QUk8TG9gCw+pheQxMf0ApL4mF5AFh/TC0jiY3oB/8ZnrvcwvYAkPqYXkMTHL92BJj6mF1DFxwfPQBIf0wto4mN6AVV8jkIkQXzEB8RHfADxER8QH/EBxEd8QHzEBxAf8QHxER9AfMQHxEd84CvDMzRHfEB8xAfER3wA8REfEB/xAcRHfEB8xAcQn/v5o3sQH/EB8REfQHzEB8RHfADxER8QH/EBxEd8QHzEBxAf8QHxER/gyyMpPsCfAZriA5zt+hEf4GqANvEBqgCJD3Ca60d8gOT6ER8guX78hSqQXD/iAyTXj/gAyfUjPsBd8RniA1QBmuIDHPX6ER8guX7EB0iuH/EBkutHfIDk+hEf4KkAbeIDVAESH+Aw14/4AMn1Iz5Acv2ID5BcP+IDJNeP+AAvDdAtXzz0F6rAy+MzxAfY6/UjPkBy/YgPkFw/4gMk14/4AMn1Iz7A2wMkPkASn018gL1cP+IDJNeP+ADJ9SM+QHL9iA+QXD/iAyTXj/gAHw/QFB+giM8QHyCbX14BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB25wdZK/69WtOUTwAAAABJRU5ErkJggg=='

export const STOP_ALL_PNG64 =
	'iVBORw0KGgoAAAANSUhEUgAAASAAAAEgCAYAAAAUg66AAAACmUlEQVR42u3aQQ0AAAwCMfyb3myQ0GrY7kUCAAAAAAAAAAAAAAAAACWOai4UAUKAQIAECAQIAQIBEiAQIAQIBEiAQIAQIBAgAQIBQoBAgAQIBAgBAgESIBAgBAgBQoBAgBAgBAgBAgESIBAgBAgESIBAgBAgECABAgHySIAAAQIkQIAAAQIEIECAAAECJEDAdoBMDg0iESABQoAQIAQIARIgBAgBQoAQIAESIBAgBAgBEiABAgFCgBAgARIgECAECAESIAECAUKAECABEiAQIAQIARIgAUKABAgBQoAQIARIgBAgBAgBQoAESIBAgBAgBEiABAgECAFCgARIgECAECAESIAECAQIAUKABEiAQIAQIARIgAQIBAgBQoAESIAQIAFCgBAgBAgBEiAECAFCgBAgARIgECAECAESIAECAUKAECABEiAQIAQIARIgAQIBQoAQIAESIBAgBAgBEiABQoAECAFCgBAgBEiAECAECAFCgAQIn4IQIkAgQAIEAoQAgQAJEAgQAgQCJEAgQAgQCJAAgQAhQCBAAgQChACBAAkQCBAChAAhQCBACBAChACBAAkQCBACBAIkQCBACBAIkACBACFAIEACBAKEAIEACRAIEAIEAiRAIEAIEAKEAIEAIUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIMel5Ov9/asxEEAAAAASUVORK5CYII='

export const CHEVRON_RIGHT_PNG64 =
	'iVBORw0KGgoAAAANSUhEUgAAASAAAAEgCAYAAAAUg66AAAADYklEQVR42u3cQW7CMBCG0RwtR/PN5mjDBsQGSCQiT2y/t+6qqn59nrZsGwAAAAAAAAAAAAAAAAAAAMClMnPPzJaZkd/F82t23zHgitH5NThHwhgBvYfHEAHlw2OIgNPj00vzHQde4xPZnxoC41MyPmoIjE/5+KghcPO5DTUExkcNAfM/vdQQqB81BKgfNQTqRw0B6kcNwUQDNAs1BJ5fagg4N0At56SGwP1HDQHz33/UEBggNQQYIDUEBkgNAQZIDYEBUkPAe4DC/qghqBqgZnvUEFQN0G5z1BC4A6khcAdCDYFnmBoCFYQaAhWkhkAFoYZABakhMEKoIfAUU0NghNSQGgIjpIbATUgNAf+OkBpSQ1A6RD66Qw2BGlJDoIZQQ6CG1BCoIdQQqCE1BGoINQRqSA2BGkINgRpSQ6CGUEOghgZhhEAN1daQnyBQQ0YI1JARAtSQmxCoISMEqCFPMVBDKghQQyoI1JAKAtSQCgI1NA8/HaCGPMNADS3JR3eAGnIHAjXkDgSoIQMEasgAAQbIAIEnmAECVI8BAtXj1/CA6vGHiKB6/CsGoHrcf0D1uP+A6sHzC1SP+gHVg/oB1aN+QPWoH0D1GB9QPZ5egOoxPqB6jA+oHtx8QPWMUD3GB1RPBR+xAapH9YDqUT2A6lE9oHpUD6ge+6F6QPWoHlA9qB5QPaoHVA+qB1SP6oHhxgfVA93HR/WoHjA+qgeMD6oH3HxUDxgfVA94eqkeUD+qB1A/qgfUj+oB1I/qgfsOEKoHPL9UD6w1QD5iQ/WA+4/qAfcf1QMYINUDBkj1AAZI9YABUj2AAVI9MP4AheoBqgaoqR6gaoB21QO4A6kecAdSPYBnmOoBFaR6ABWkekAFqR5gtQpSPWCEVA+wxlNM9YARUj3AGiOkeoCSm5DqAT6OUKgeYKYhMjxA9yEyPMBlY9QOBimeX2N0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAungAuSejt6Pr+lUAAAAASUVORK5CYII='

export const CHEVRON_LEFT_PNG64 =
	'iVBORw0KGgoAAAANSUhEUgAAASAAAAEgCAYAAAAUg66AAAADYUlEQVR42u3cSw6CQBREUZbG0thZL+05cWQCmEj6gXXO2JGayu32sywAAAAAAAAAAAAAAAAAAAAAHKiqtaq2qhq1b7wfs3rGgCtG52hwzgxjBMweHkMEtA+PIQK+Gp+t5jFCwJTq2a0hzz6onk5GCFSPEQIyqsedEKgeIwTkVo+jGKgeFQRkVo8KAtWjgoDM6lFBoHruwysKqscxDMiong+bVxhUj3sgIKJ63AOB6jFAQGD1GCBQPQYIVE9e9RggUD0GCFRPNB/Dg+rxRURQPXn8FANUj/sfUD3ufwDV4/gFqkf9AKpH/YDqUT+A6lE/oHqMD6geHL1A9RgfUD0YH1A97nxA9SRWj/EB1dPBX2yA6lE9oHpUD6B6VA+oHtUDqsd+qB5QPaoHVA+qB1SP6gHVg+oB1aN64HHjg+qB6eOjelQPGB/VA8YH1QPufFQPGB9UDzh6qR5QP6oHUD+qB9SP6gHUj+qB+w4Qqgccv1QPZA2Qv9hQPeD+R/WA+x/VAxgg1QMGSPUABsgAgQFyBAMMkBqC5w+Qj+HVELQNkC8iqiFoGyA/xVBD4B5IDYF7INQQOIapIVBBqCFQQWoIVBBqCFSQGgIjhBoCRzE1BEZIDakhMEJqCNwJqSHg5xFSQ2oIWofIX3eoIVBDagjUEGoI1JAaAjWEGgI1pIZADaGGQA2pIVBDqCFQQ2oI1BBqCNTQQxghUEO9NeQdBGrICIEaMkKAGnInBGrICAFqyFEM1JAKAtSQCgI1pIIANaSCQA39D+8OUEOOYaCGIvnrDlBD7oFADbkHAtSQAQI1ZIAANWSAQA0ZIEANGSBQQz6GB9SQLyKCGvJTDEANuf8BNeT+B1BDjl+ghtQPoIbUD6gh9QOE1ZD6ATVkfICcGnL0AjVkfICcGjI+QEsNufMBptfQMD7A7CEyPMD0ITI8wGVjtJ0M0ng/xugAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA39QKGyaO3ifbX1AAAAABJRU5ErkJggg=='

export const PLUS_PNG64 =
	'iVBORw0KGgoAAAANSUhEUgAAASAAAAEgCAYAAAAUg66AAAACDUlEQVR42u3UAQkAAAgDwfUvrSEEEbmLIO4TAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAJ2qZiwMCBAgQIEACBAgQIEACBAgQIEACBAgQIEACBAgQIEACBAgQIEACBAgQIEACBAgQIEAAAgQIECBAAgQIECBAAgQIECBAAgQIECBAAgQIECBAAgQIECBAAgQIEBg49/lYBAgBAgESIBAgBAgESIBAgBAgECABAgFCgECABAgECAECARIgECAECAFCgECAECAECAECAUKAECAECARIgECAECAQIAECAUKAQIAECAQIAQKBNHBAgAABEiBAgAABEiBAgAABAhAgQIAAARIgQIAAARIgQIAAARIgQIAAARIgQIAAARIgQIAAARIgQIAAARIgQIAAAQIESIAAAQIESIAAAQIESIAAAQIESIAAAQIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGCgARqpkQ9fV0w5AAAAAElFTkSuQmCC'

export const MINUS_PNG64 =
	'iVBORw0KGgoAAAANSUhEUgAAASAAAAEgCAYAAAAUg66AAAABmElEQVR42u3UwQkAAAgDse6/tK5Q8CUkMxyXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAteEVxWJAGBAYkAGBAWFAYEAGBAaEAYEBGRAYEAYEBmRAYEAYEBiQAYEBYUAYEAYEBoQBYUAYEBgQBoQBYUBgQAYEBoQBgQEZEBgQBgQGZEBgQBgQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwsO78q2v1yly8AAAAAElFTkSuQmCC'

/** Gap after a failed attempt before the next one, in ms (fixed, no backoff) */
export const RECONNECT_MS = 5000

/** Longest silence between state frames before the socket is treated as lost, in ms */
export const WATCHDOG_MS = 5000

/** WebSocket opening handshake timeout, in ms */
export const HANDSHAKE_TIMEOUT_MS = 5000

/** REST request timeout, in ms; below Companion's 5 s action IPC timeout */
export const REST_TIMEOUT_MS = 4000

/** Interval between re-checks while a pre-2.0 BreakTime is detected, in ms */
export const VERSION_RECHECK_MS = 60000

/** Display time of a warning raised by a local guard, in ms */
export const WARNING_LOCAL_MS = 2000

/** Display time of every other warning, in ms */
export const WARNING_MS = 5000

/** Maximum length of a `detail=` log value, in characters (Unicode code points) */
export const LOG_DETAIL_MAX = 200

/**
 * Valid port text, as a `/.../` string for the config form's `regex`: 1 to 65535, with
 * optional leading zeros
 *
 * Base's `Regex.PORT` stops at 65534 and refuses leading zeros. main.ts checks the stored
 * port with this same pattern, so the form and the module accept exactly the same values.
 * Leading zeros stay valid because the module has always connected with them (1.x had no
 * port check), so a zero-padded port saved by 1.x keeps working.
 */
export const PORT_REGEX = '/^0*([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/'

/**
 * Valid host text, as a `/.../` string for the config form's `regex`: a hostname or IPv4 address
 *
 * The exact pattern base's deprecated `Regex.HOSTNAME` carried (also matching IPv4), kept as a
 * literal here so host values saved by 1.0.3 stay valid and the module no longer references the
 * deprecated constant. main.ts checks the stored host with this same pattern.
 */
export const HOSTNAME_REGEX =
	'/^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])\\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$/'

/** Default number of running-event variable slots */
export const DEFAULT_RUNNING_SLOTS = 4

/** Maximum number of running-event variable slots */
export const MAX_RUNNING_SLOTS = 32

/** Shortest event duration BreakTime accepts, in seconds (its clamp floor) */
export const DURATION_MIN_S = 6

/** Longest Splice Insert (`MessageMode` 0) duration BreakTime accepts, in seconds */
export const DURATION_MAX_SPLICE_S = 6553

/** Longest Time Signal (`MessageMode` 1) duration BreakTime accepts, in seconds */
export const DURATION_MAX_TIME_SIGNAL_S = 65535

/** Largest amount Armed Duration + / - accepts, in seconds */
export const DURATION_STEP_MAX_S = 65535

/** How long a Set Armed Duration target is held while no frame shows it yet, in ms */
export const PENDING_DURATION_MS = 2000

/**
 * How long after a Start (or End) press that sent a request a further Start (or End) press is ignored, in ms
 *
 * Start and End each have their own window; arm and duration actions are not debounced.
 */
export const PRESS_DEBOUNCE_MS = 500

/** Event choices shown before the first state frame arrives; copied, never assigned directly */
export const CHOICES_EVENTS_PLACEHOLDER: ReadonlyArray<Choice> = Object.freeze([
	Object.freeze({ id: '0', label: 'Loading Events...' }),
])

/** Duration mode choices; IDs are the BreakTime `DurationMode` values as strings */
export const CHOICES_DURATION_MODES: Choice[] = [
	{ id: '1', label: 'Count Up' },
	{ id: '0', label: 'Count Down' },
]

/** The Start Event dropdown entry that targets whatever event is armed */
export const CHOICE_ARMED_EVENT: Readonly<Choice> = Object.freeze({
	id: 'armed',
	label: 'Armed event (as shown in Companion)',
})

/** End Running Event targets */
export const CHOICES_END_TARGETS: Choice[] = [
	{ id: 'latest', label: 'Latest running' },
	{ id: 'all', label: 'All running' },
	{ id: 'specific', label: 'Specific event' },
]

/** Warning types for the `temporaryWarning` feedback */
export const CHOICES_WARNINGS: Choice[] = [
	{ id: 'event', label: 'Event Related' },
	{ id: 'increaseDuration', label: 'Increase Duration Not Allowed' },
	{ id: 'decreaseDuration', label: 'Decrease Duration Not Allowed' },
	{ id: 'scte104', label: 'SCTE 104 Disconnected' },
	{ id: 'vmix', label: 'vMix Disconnected' },
	{ id: 'ack', label: 'Action Problem' },
	{ id: 'auth', label: 'Authentication' },
	{ id: 'version', label: 'Unsupported BreakTime Version' },
	{ id: 'connection', label: 'Request Failed' },
	{ id: 'ha', label: 'Sent to HA Standby' },
	{ id: 'global', label: 'BreakTime Warning' },
]

/** The `temporaryWarning` choice that matches a warning of any type; a feedback option only, never a warning type */
export const CHOICE_ANY_WARNING: Readonly<Choice> = Object.freeze({ id: 'any', label: 'Any warning' })

/** Component choices for the `componentStatus` feedback, by slug */
export const CHOICES_COMPONENTS: Choice[] = COMPONENTS.map((component) => ({
	id: component.slug,
	label: component.key,
}))

/** Component status names indexed by BreakTime's `Status` value (0 Disabled, 1 Unhealthy, 2 Warning, 3 Healthy) */
export const COMPONENT_STATUS_NAMES: ReadonlyArray<ComponentStatusName> = Object.freeze([
	'Disabled',
	'Unhealthy',
	'Warning',
	'Healthy',
])

/** Component status choices for the `componentStatus` feedback */
export const CHOICES_COMPONENT_STATUSES: Choice[] = [
	{ id: 'Healthy', label: 'Healthy' },
	{ id: 'Warning', label: 'Warning' },
	{ id: 'Unhealthy', label: 'Unhealthy' },
	{ id: 'Disabled', label: 'Disabled' },
	{ id: 'Unknown', label: 'Unknown' },
]

/** HA link state choices for the `haLinkState` feedback; BreakTime's `HA.LinkState` names */
export const CHOICES_LINK_STATES: Choice[] = [
	{ id: 'Inactive', label: 'Inactive (standalone)' },
	{ id: 'Connecting', label: 'Connecting' },
	{ id: 'Connected', label: 'Connected' },
	{ id: 'Degraded', label: 'Degraded' },
]

/** Event targets for the `eventIsRunning` feedback */
export const CHOICES_RUNNING_TARGETS: Choice[] = [
	{ id: 'any', label: 'Any event' },
	{ id: 'armed', label: 'Armed event' },
	{ id: 'specific', label: 'Specific event' },
]

/**
 * Formats whole seconds as `m:ss` (minutes are not capped at 59)
 *
 * Used for the `eventTile` text and the Set Duration preset labels. Example: 90
 * gives `1:30`; 3725 gives `62:05`. A negative input gives `0:00`.
 *
 * @param seconds - Seconds
 * @returns `m:ss`, or '' for a non-finite input
 */
export function formatClock(seconds: number): string {
	const total = Math.max(0, Math.floor(Number(seconds)))

	if (!Number.isFinite(total)) {
		return ''
	}

	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Returns text that Companion shows as typed on a button
 *
 * Companion 4.1 and 5.1 have no escape for button text: they replace each
 * `$(connection:variable)` with that variable's value, and turn a literal backslash
 * followed by `n`, `r` or `t` into a line break or a tab. A zero-width space
 * (U+200B) after each `$` that comes before `(`, and after each backslash that comes
 * before `n`, `r` or `t`, stops both without a visible change. For text the
 * module puts on a button only: variable values and log text keep the original.
 *
 * Hot path (every tile on every frame): text with no `$` and no backslash is returned
 * unchanged without a regex pass.
 *
 * @param text - Text to show as typed, for example an event name
 * @returns The text, with those sequences broken by a zero-width space
 */
export function literalButtonText(text: string): string
export function literalButtonText(text: string | undefined): string | undefined
export function literalButtonText(text: string | undefined): string | undefined {
	if (typeof text !== 'string' || (!text.includes('$') && !text.includes('\\'))) {
		return text
	}

	// '$$' in a replacement string inserts one '$'
	return text.replace(/\$(?=\()/g, '$$' + ZERO_WIDTH_SPACE).replace(/\\(?=[nrt])/g, '\\' + ZERO_WIDTH_SPACE)
}

/**
 * Returns a new, independent BreakTime state object
 *
 * Replaces the old shared `DATA` object, which `Object.assign` copied by reference,
 * so a "reset" reused the already-mutated object.
 *
 * @returns Fresh state with nothing armed, nothing running and connectivity unknown
 */
export function createDefaultData(): BreakTimeData {
	const components: Record<string, ComponentState> = {}

	for (const component of COMPONENTS) {
		components[component.slug] = { status: 'Unknown', detail: '' }
	}

	return {
		events: [],
		selectedEvent: undefined,
		running: [],
		runningEventsCount: '',
		slotByEventId: new Map(),
		slotEvents: [],
		scte104Status: 'Unknown',
		vmixStatus: 'Unknown',
		components: components,
		componentsSeen: {},
		ha: null,
		haSeen: null,
		haRoleAlarm: null,
		eventNames: new Map(),
		warningText: '',
		temporaryWarning: false,
		temporaryWarningType: undefined,
		scte104SpliceEventID: '',
		scte104SegmentationEventID: '',
		breaktimeVersion: '',
		breaktimeSecurity: '',
	}
}

/**
 * Constant values mixed onto the module class, so each one is also readable as `this.<NAME>`
 *
 * Holds no per-instance state and no methods that use `this`; it exists so the connection,
 * action, feedback, variable and preset code can read these shared values through `self`.
 */
export const defaults = {
	RECONNECT_MS,
	WATCHDOG_MS,
	HANDSHAKE_TIMEOUT_MS,
	REST_TIMEOUT_MS,
	VERSION_RECHECK_MS,
	WARNING_LOCAL_MS,
	WARNING_MS,
	LOG_DETAIL_MAX,
	PORT_REGEX,
	HOSTNAME_REGEX,
	DEFAULT_RUNNING_SLOTS,
	MAX_RUNNING_SLOTS,
	DURATION_MIN_S,
	DURATION_MAX_SPLICE_S,
	DURATION_MAX_TIME_SIGNAL_S,
	DURATION_STEP_MAX_S,
	PENDING_DURATION_MS,
	PRESS_DEBOUNCE_MS,
	COLORS,
	PLAY_PNG64,
	STOP_PNG64,
	BOLT_PNG64,
	STOP_ALL_PNG64,
	CHEVRON_RIGHT_PNG64,
	CHEVRON_LEFT_PNG64,
	PLUS_PNG64,
	MINUS_PNG64,
	CHOICES_EVENTS_PLACEHOLDER,
	CHOICES_DURATION_MODES,
	CHOICE_ARMED_EVENT,
	CHOICES_END_TARGETS,
	CHOICES_WARNINGS,
	CHOICE_ANY_WARNING,
	COMPONENTS,
	CHOICES_COMPONENTS,
	COMPONENT_STATUS_NAMES,
	CHOICES_COMPONENT_STATUSES,
	CHOICES_LINK_STATES,
	CHOICES_RUNNING_TARGETS,
	formatClock,
	literalButtonText,
	createDefaultData,
}

/** The shape the `defaults` constants add to the module class */
export type DefaultsMixin = typeof defaults
