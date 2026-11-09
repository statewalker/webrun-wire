---
"@statewalker/webrun-rpc": patch
"@statewalker/webrun-http-streams": patch
---

Types only, no runtime change: the generator wrappers behind `returningAtOnce` (webrun-rpc) and an `httpServe` handler's body (webrun-http-streams) typecheck with Node's types too, where `AsyncGenerator` requires `Symbol.asyncDispose` (they add it where the runtime has it). The shipped `src/` changes; `dist/*.js` does not.
