# Changesets

A changeset records a package release: which packages, which bump, and the changelog text.

- `pnpm changeset` writes one; commit it with the change it describes. It decides the bump and the
  changelog text of the next release.
- Without one, the release planner writes a patch changeset for every package whose published
  contents changed since npm's `latest` (a minor, on 0.x, when a dependency moved to another
  breaking line).
- Releases go through CI only; see [`PUBLISHING.md`](../PUBLISHING.md). After CI passes on `main`,
  a job opens (or updates) a "chore: version packages" pull request that applies the changesets
  (versions, `CHANGELOG.md`). Merging it runs CI's `publish` job, which publishes to npm once a
  maintainer approves it. Do not run `changeset version` or `changeset publish`, or publish to npm,
  from a local checkout; the one exception, a new package's first version, is described there.
