---
"@statewalker/webrun-rpc": patch
"@statewalker/webrun-http-browser": patch
---

Ready for `await using` where the runtime has `Symbol.asyncDispose`: `connect`'s calls and `duplexOverPort`'s caller streams dispose as `return()` (the stream ends at once, even with a `next()` pending), and an `HttpLink` disposes as `close()`. Native async generators get this from `AsyncIteratorPrototype` in runtimes that implement it; these hand-written iterators carry it themselves. Installed at run time only, and kept off the declared types, which would otherwise require the `esnext.disposable` lib.
