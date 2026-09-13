---
"@statewalker/webrun-http-proxy": minor
---

New package: a reverse proxy as a fetch handler.

One route table, two kinds of upstream — an in-process handler, or a remote
origin — and the finding that they are one mechanism: only the last step
differs (a local handler is *called*, a URL upstream is *re-issued*), while
matching, rewriting, the listing, the marker header and streaming are shared.
Twelve scenarios establish it.

Extracted from `@statewalker/httpeers-expose`, where it was a mesh concept by
accident of where it was written. Nothing in it is about peers. The one place
the old package knew about meshes is now `stripRequestHeaders`, so any caller
can name whatever its own system treats as proven identity and keep it from
reaching a third-party origin.

Ships with **zero runtime dependencies**: the single import it carried was a
one-line `FetchHandler` type, so extracting it dropped a dependency rather than
moving one. Two defects it had already fixed come with it — a redirecting
upstream reported as `502 upstream-unreachable`, and an outbound request that
carried no `signal`.
