# Publishing

Packages are published to npm from CI with changesets. Nobody runs `changeset version` or
`changeset publish` by hand.

1. CI runs on every push to `main`.
2. After CI passes, a job compares each package's packed contents with the version on npm. For
   every package that differs it writes a changeset: a patch bump, or a minor bump on a 0.x package
   when one of its dependencies crosses a breaking line.
3. The job opens (or updates) a "chore: version packages" pull request with the version bumps and
   `CHANGELOG.md` entries.
4. Merging that pull request packs every package whose version is not on npm yet. Nothing is
   published until a maintainer approves the `publish` job on the `npm` GitHub environment; it then
   publishes the tarballs with provenance and creates a GitHub release per package.

The checks do not run on the version pull request itself (GitHub Actions opened it); they run
again on `main` after the merge, before anything is packed. The release waits for both the shared
CI and the browser suites.

## No npm token: trusted publishing

GitHub holds no npm token. The `publish` job authenticates with npm trusted publishing (OIDC). Each
package's trusted publisher names `statewalker/webrun-wire`, `ci.yml` and the `npm` environment, so
a run that skips the approval cannot publish. Only `publish` may request an identity token, and it
never installs or builds, so no dependency code runs where a publish token can be obtained.

A trusted publisher can only be added to a package that already exists, so a **new package's first
version is published by hand** with the maintainer's 2FA (`pnpm pack` in the package, then
`npm publish <tarball> --access public`), followed by:

```bash
npm trust github @statewalker/<name> --repo statewalker/webrun-wire --file ci.yml --env npm --allow-publish
```

Without it, `publish` fails with `E404 Not Found - PUT https://registry.npmjs.org/@statewalker%2f<name>`:
npm reports a missing trusted publisher as "not found", not as a permission error. Re-run the failed
job once the publisher is added; it reuses the packed tarballs and skips versions already on npm.

## Choosing the bump or the changelog text yourself

Add a changeset in your pull request:

```bash
pnpm changeset
```

Pick the packages, the bump and write the summary.

## On a 0.x line, a breaking change is a minor bump

Every package here is below 1.0. npm's caret range treats `0.x` specially: `^0.1.1` allows `0.1.2`
but not `0.2.0`. On a `0.x` line the minor position is what carries a break, and it is the position
consumers' ranges protect them against. A `major` bump would declare 1.0, a stability commitment
none of these packages makes yet. So:

- **`0.x` breaking change: `minor`** (`0.1.1` -> `0.2.0`), with the break stated in the changeset
  summary and the commit marked `!` (for example `feat(streams)!:`).
- `major` applies once a package reaches `1.0.0`.

## Why `updateInternalDependencies` is `minor`

`.changeset/config.json` sets `updateInternalDependencies` to `minor`, not the changesets default
`patch`. Most packages depend on `@statewalker/webrun-streams`. Under `patch`, a breaking change in
`webrun-streams` would reach every one of them as a patch release, a bump semver tells consumers is
always safe, carrying an incompatible wire protocol. `minor` puts the break outside a `^0.x.y`
range, so a consumer has to opt in. Do not lower it without a replacement mechanism.
