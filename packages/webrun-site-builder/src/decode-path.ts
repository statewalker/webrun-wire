/**
 * Percent-decode a URL path into the path a `FilesApi` stores, or reject it.
 *
 * A URL pathname is percent-encoded by definition — `new URL("http://h/My
 * Report.html").pathname` is already `/My%20Report.html` — while a `FilesApi`
 * stores the decoded name. Without this step every file whose name carries a
 * space, a `#`, or a non-ASCII character answers `404` although it exists.
 *
 * Decoding is per SEGMENT, and that is the security-relevant part.
 * `@statewalker/webrun-files`' `normalizePath` drops `.` segments but does
 * **not** resolve `..`, and a root-anchored backend such as
 * `@statewalker/webrun-files-node` resolves `rootDir + path` on the real
 * filesystem — so a `..` that survives into the lookup escapes the mount. A
 * whole-path `decodeURIComponent` would turn `/..%2f..%2fetc/passwd` into
 * `/../../etc/passwd` and manufacture exactly that escape out of what is
 * otherwise a cosmetic 404 fix. The decode and the guard therefore happen
 * together, and a segment that decodes to a dot-segment or to something
 * containing a separator is never decoded into one: the whole path is
 * rejected.
 *
 * Decoding happens **once**. A double-encoded `%252e%252e%252f` decodes to the
 * literal text `%2e%2e%2f`, which is a strange file name and nothing more; it
 * is not decoded again.
 *
 * A malformed escape (`%zz`, a trailing `%`) is **not** an error. A file name
 * may legitimately contain a `%`, a hand-written link does not have to encode
 * it, and `decodeURIComponent` throws `URIError` on such input — an unhandled
 * throw inside a fetch handler is a `500` where a `404` belongs. The raw
 * segment is used instead, and still passes every check below, so the answer
 * is either the file that really is named that or an ordinary `404`.
 *
 * @param pathname a URL path, percent-encoded
 * @returns the decoded path, or `null` when the path must not be looked up at
 *   all
 */
export function decodeUrlPath(pathname: string): string | null {
  const out: string[] = [];
  for (const segment of pathname.split("/")) {
    if (segment === "") {
      // An empty segment (leading, trailing, or a doubled slash) carries no
      // name; `normalizePath` collapses it downstream.
      out.push(segment);
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment;
    }
    // Dot-segments are rejected rather than resolved. A browser normalizes
    // `.` and `..` out of a URL before it is sent, so one arriving here is
    // either an encoded dot-segment — the attack — or a non-browser client
    // relying on a resolution this layer deliberately does not perform.
    if (decoded === "." || decoded === "..") return null;
    // A separator that appears only after decoding would re-partition the
    // path behind the split above, so it is refused rather than decoded.
    // `\` is included because it is a separator on Windows-backed storage;
    // `\0` because it truncates a path in a C-string filesystem call.
    if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) return null;
    out.push(decoded);
  }
  return out.join("/");
}
