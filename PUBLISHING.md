# Publishing Guide

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version management and publishing.

## Quick Reference

```bash
pnpm changeset          # Create a changeset
pnpm version-packages   # Bump versions from changesets
pnpm release-packages   # Publish to npm
```

## Step-by-Step Publishing Flow

### 1. Create a Changeset

After making code changes, create a changeset to describe what changed:

```bash
pnpm changeset
```

This will prompt you to:
- Select which packages have changed
- Choose the semver bump type (`patch`, `minor`, or `major`)
- Write a summary of the changes

A new markdown file will be created in `.changeset/` directory.

### 2. Version the Packages

When ready to release, consume all pending changesets and update package versions:

```bash
pnpm version-packages
```

This command:
- Reads all changeset files in `.changeset/`
- Updates `package.json` versions for affected packages
- Generates/updates `CHANGELOG.md` files
- Deletes the consumed changeset files

### 3. Commit Version Changes

```bash
git add .
git commit -m "chore: version packages"
```

### 4. Publish to npm

```bash
pnpm release-packages
```

This publishes all packages with updated versions to npm.

### 5. Push to Git

```bash
git push --follow-tags
```

## Alternative: Manual Publish

For more control, you can use the `publish-all` script which builds and publishes with public access:

```bash
pnpm publish-all
```

## Configuration

Changeset configuration is in `.changeset/config.json`:

| Option | Value | Description |
|--------|-------|-------------|
| `access` | `restricted` | npm access level (use `publish-all` for public) |
| `baseBranch` | `main` | Branch to compare against |
| `commit` | `false` | Don't auto-commit version changes |
| `updateInternalDependencies` | `minor` | Bump level applied to a package because a workspace dependency of it was bumped. See the note below. |

`updateInternalDependencies` is **`minor`, not the changesets default of
`patch`**, and that is deliberate. Eleven packages depend on
`@statewalker/webrun-streams` via `workspace:*`. Under `patch`, a breaking
change inside `webrun-streams` reaches every one of them as a *patch* release —
a version bump that semver tells consumers is always safe to take, carrying an
incompatible wire protocol. `minor` puts the break outside a `^0.1.x` range, so
a consumer has to opt in. Do not lower it back without a replacement mechanism.

## Semver Guidelines

- **patch**: Bug fixes, documentation updates
- **minor**: New features, non-breaking changes
- **major**: Breaking changes to the API

### On a `0.x` line, breaking changes are a **minor** bump

Every package here is pre-1.0. Semver gives `0.x` its own rule, and npm's
caret range implements it: `^0.1.1` allows `0.1.2` but **not** `0.2.0`. So on a
`0.x` line the minor position is what carries a break, and it is the position
consumers' ranges actually protect them against.

A `major` bump would assert 1.0 — a stability commitment none of these packages
is making yet. So:

- **`0.x` breaking change → `minor`** (`0.1.1` → `0.2.0`), with the break stated
  in the changeset summary and the commit marked `!` (e.g. `feat(streams)!:`).
- Read the **major** row above as applying once a package reaches `1.0.0`.

The `updateInternalDependencies: "minor"` setting above is the same rule applied
to dependents: it is what stops a `0.x` break from reaching them as a patch.
