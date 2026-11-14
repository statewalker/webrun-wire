---
"@statewalker/webrun-http-streams": minor
---

Stubs and `HttpError`: `newHttpServerStub` forwards only the known `RequestInit` fields of the envelope (a `body` key on a GET no longer makes `new Request` throw). `SerializedHttpResponse` gains an optional `headerEntries: [string, string][]`, set by the server stub next to the unchanged `headers` record and preferred by the client stub, so repeated headers such as `set-cookie` survive. `HttpError.fromError` now uses the reason "Internal Server Error" for its 500 instead of "Bad Request".
