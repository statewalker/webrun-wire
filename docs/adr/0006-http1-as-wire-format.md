# 6. HTTP/1.1 as the wire format for webrun-http-streams

Date: 2026-08-18

## Status

Accepted. Supersedes the wire-format conclusion of note
`2026-08-16/httpeers-plan/15-resolved-both-show-stoppers-fixed-by-replacing-libp2p-http.md`.

## Context

`webrun-http-streams` carried HTTP over a `Duplex` as a JSON envelope, a
newline, then raw body bytes. That format is minimal and correct, and
understood by nothing outside this workspace.

Note 15 (17 August 2026) adopted it after finding three defects in
`@libp2p/http` — a dropped query string, empty streamed bodies, and chunk
lengths written in decimal — and argued the envelope was immune to all three
*structurally*, because nothing re-serialises a request line.

That argument was correct about `@libp2p/http`. It is also the reason the
format cannot interoperate: the property being optimised for is precisely the
absence of the request line that makes a message intelligible to anyone else.

## Decision

HTTP/1.1 becomes the default and documented wire format, behind a
`MessageCodec` seam that retains the JSON envelope as a second implementation.
Readers sniff byte 0 — `{` is not a token character and so can never begin an
HTTP start-line — and accept either format, so a peer pair can be upgraded in
either order with no negotiation. A server answers in the codec that read the
request.

Framing is `Content-Length` when the caller declares one, chunked otherwise,
never both. One message per `Duplex` call, `Connection: close` always emitted.
The codec is hand-rolled and strict: every ambiguity is a refusal. That
strictness extends to the `Host` header on decode — it is validated against
the RFC 3986 `authority` grammar (`host [ ":" port ]`, no userinfo) before any
URL is reconstructed from it. Without that check an empty `Host:` produced
`http:///x`, which `new URL()` parses with host `x` and path `/` — silently
turning the request path into the hostname it then routes on.

The strictness also covers a case RFC 9112 §2.2 explicitly leaves to the
recipient's discretion: a single CRLF sent before the request-line, which a
server "SHOULD ignore" for robustness. This codec refuses it — a leading
CRLF produces an empty first line, which fails the request-line's `method
target version` shape and is rejected as malformed, the same as any other
ambiguous input. This was an agreed remedy that was not delivered when the
strictness posture above was first written; it is recorded here as closed.

## Consequences

**The three defect classes return, and are answered by verification.** The
conformance suite runs both directions against `node:http` over a real socket,
re-runs note 15's streaming proofs by arrival timestamp, and asserts a
seventeen-case hostile corpus is *rejected* — including `Content-Length`
together with `Transfer-Encoding`, which is the request-smuggling class. A
malformed `Host` header — empty, carrying userinfo, or containing whitespace —
is rejected too, covering the authority-confusion class above, though as its
own cases rather than folded into that corpus. The encoder is asserted to
write chunk sizes in hex: that is the one defect no parser can catch
downstream, because decimal digits are also valid hex.

**No library was adopted.** Surveyed 2026-08-18: `llhttp-wasm` compiles its
60 KB wasm synchronously, which Chrome forbids above 4 KB on the main thread —
fatal for a package that loads on browser pages; `@perseveranza-pets/milo` is
ESM-native and well maintained but a 0.x wasm parser with no serializer;
`http-parser-js` needs Node's `Buffer` and is deliberately lenient; `undici` is
Node-only; browsers expose no HTTP/1.1 message parser at all; and no HTTP/1.1
*serializer* exists to adopt at any layer. The package keeps its single runtime
dependency.

**The scheme is not on the wire.** Origin-form request targets carry no scheme,
so it comes from codec configuration. A peer configured `http` rebuilds an
`https` url as `http`, silently. Chosen deliberately over carrying
`X-Forwarded-Proto`.

**`Connection: close` is emitted into a topology with no connection.** There is
nothing to close; it is there so a real peer does not wait for a second message
on the stream.

**A peer-error response must still free its stream slot.** On a mux transport
(`@statewalker/webrun-streams`'s `emulateMux`), the `Duplex` contract's
`finally` — the one that frees the client's stream-table entry — only runs
when the consumer calls `.return()` on the output generator. `httpFetch`'s
peer-error path used to just throw after reading the error envelope, leaving
that generator un-returned; every peer error then leaked one mux stream-table
entry, unboundedly, until `maxStreams` was exhausted and every further call
started failing. The fix cancels the output generator on that path before
throwing. It is safe specifically because it is the client's own
response-only generator and the request has already been fully sent; the same
cancel is not safe inside the codec's decode logic itself, where the same
object can still be read from *and* written back to (a server replying on the
socket it just read the request from).

**A related leak exists upstream, unfixed.** `emulateMux`'s inbound generator
frees the client-side stream-table entry from its own `finally`, but only by
calling `onCancel()`, and only `if (!doneCalled)`. On a normally-completed
call the `TYPE_END` frame handler sets `doneCalled` before that `finally`
runs, so `onCancel()` never fires and the entry is never freed — a leak on
the happy path, independent of the peer-error leak above and not something
this package fixes. Anything using `emulateMux` as its transport should treat
this as a known issue.

**Keep-alive and pipelining are permanently out of scope.** A `Duplex` carries
one logical call (ADR-0004); a bridge that needs connection reuse owns that
itself. No socket bridge ships with this change.
