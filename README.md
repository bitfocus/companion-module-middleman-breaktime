# companion-module-middleman-breaktime

Bitfocus Companion module for Middleman Software's BreakTime.

## Compatibility

| Module | BreakTime     | Companion     | Node runtime |
| ------ | ------------- | ------------- | ------------ |
| 1.x    | 1.1           | 3.5 and later | node18       |
| 2.x    | 2.0 and later | 4.1 and later | node22       |

- Module 1.x is built on `@companion-module/base` ^1.11.2, which Companion supports from 3.5.
- Module 2.x is built on `@companion-module/base` ~1.13.5.
- For BreakTime 1.1, use module v1.0.3: 2.x reports BreakTime 1.x as unsupported.
- Tested with BreakTime 2.0.225-beta and Companion 5.1.0.

## Building

- `yarn package` builds the release package, `middleman-breaktime-<version>.tgz`, with the version in package.json.
- `yarn package:beta` builds a customer test package, marked as a prerelease, versioned `<version>-beta.<N>+<commit>`, for example `2.0.0-beta.1+6184928d10`. N counts commits since the package.json version last changed (the commit that changed it is 1), and `<commit>` is the first 10 characters of the hash of the commit it was built from. Every beta sorts below the release of the same version. The file name shows the `+` as `-`.
- Beta builds need a full clone with everything committed. To build with uncommitted changes anyway, for local testing only, use `yarn package:beta --allow-dirty`; it prints a warning.
- After a release, raise `"version"` in package.json before building more betas, or they sort below that release.

See [HELP.md](./companion/HELP.md), [LICENSE](./LICENSE) and [THIRD-PARTY-NOTICES.txt](./THIRD-PARTY-NOTICES.txt)
