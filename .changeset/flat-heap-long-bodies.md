---
"@statewalker/webrun-http-browser": patch
---

A response body read over an HTTP link no longer keeps memory per chunk. Each read raced the reader against a promise for the link's loss, which never settles while the link lives, so every chunk left a reaction on it until the body ended: a 200,000 × 16 B body grew the heap by about 88 MB. A read now waits on the reader alone, and closing the link fails the body directly. The body still fails with the link's reason when the link closes, and an abort of the request's signal still ends it at once. One difference shows: chunks already buffered in the body when the link closes are dropped (up to about a flow-control window of data that had arrived), and the next read fails at once with the link's reason, as an abort does. A body cancelled just after its last chunk still leaves the handler the rest of the upload: the read in flight decides, on Node 22 as on Node 24.
