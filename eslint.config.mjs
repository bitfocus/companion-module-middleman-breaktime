import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default [
	...(await generateEslintConfig({
		enableTypescript: true,
		typescriptRules: {
			// The module composes its behavior from mixin objects whose methods capture the
			// instance as `const self = this` (the team's established convention); this is
			// intentional, not an accidental alias.
			'@typescript-eslint/no-this-alias': 'off',
		},
	})),
	{
		// scripts/*.cjs are CommonJS build tooling (run with node, never bundled into the
		// module), so the TypeScript/ESM source rules do not apply to them.
		files: ['scripts/**/*.cjs'],
		rules: {
			'@typescript-eslint/no-require-imports': 'off',
			'n/no-missing-require': 'off',
			'n/no-unpublished-require': 'off',
		},
	},
]
