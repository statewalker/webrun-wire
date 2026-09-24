---
"@statewalker/webrun-site-builder": patch
---

Percent-decode the request path before the `FilesApi` lookup, and reject
anything that would only become a path traversal once decoded.

`newServeFiles` handed the URL path to `FilesApi.stats()` verbatim. A URL path
is percent-encoded by definition, so a file stored as `/My Report.html` was
looked up as `/My%20Report.html` and answered `404` although it existed. Every
consumer of the builder inherited this: any site with a space, a `#`, or a
non-ASCII character in a file name — most human-authored content. `+` and `&`
were never affected and still are not: a `+` in a path is a literal plus, not a
space.

The decode is per segment, together with a traversal guard, because
`normalizePath` in `@statewalker/webrun-files` drops `.` segments but does not
resolve `..`, and `@statewalker/webrun-files-node` resolves `rootDir + path` on
the real filesystem. A whole-path `decodeURIComponent` would therefore have
turned `/..%2f..%2fetc/passwd` into a real escape — trading a cosmetic `404`
for arbitrary filesystem read. A segment that decodes to `.`, `..`, or to
anything containing `/`, `\`, or a NUL rejects the whole path with `404`,
without consulting the `FilesApi` at all. Decoding happens exactly once, so a
double-encoded `%252e%252e%252f` decodes to the literal name `%2e%2e%2f` and no
further.

This also closes a traversal that was already reachable before the decode
existed: `newServeFiles(nodeFilesApi)(request, "/../secret.txt")` read the file
outside the mount, because nothing between the handler and the backend rejected
a dot-segment.

A malformed escape (`%zz`, a trailing `%`) is deliberately not an error. A file
name may legitimately contain a `%`, and `decodeURIComponent` throws `URIError`
on such input — an unhandled throw inside a fetch handler is a `500` where a
`404` belongs. The raw segment is used instead and still passes every check, so
the answer is either the file that really is named that or a plain `404`.

The decode rule is exported as `decodeUrlPath(pathname)` for custom file layers
that do their own lookup.
