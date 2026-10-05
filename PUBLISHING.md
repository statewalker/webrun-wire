# Publishing

Packages are published to npm from CI with changesets. Nobody runs `changeset version` or
`changeset publish` by hand.

1. CI runs on every push to `main`.
2. After CI passes, a job compares each package's packed contents with the version on npm. For
   every package that differs it writes a changeset: a patch bump, or a minor bump on a 0.x package
   when one of its dependencies crosses a breaking line.
3. The job opens (or updates) a "chore: version packages" pull request with the version bumps and
   `CHANGELOG.md` entries.
4. Merging that pull request publishes the bumped packages to npm with provenance.

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
