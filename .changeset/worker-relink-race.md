---
"@statewalker/webrun-http-browser": patch
---

A worker's first `service.fetch` no longer loses its call when it runs before the worker's first link has arrived. The worker asked its page to attach it again, the page did, and the duplicate link replaced the one the call was already running on: the call failed with "webrun-rpc: the peer abandoned the stream" or, 30 s later, "The link was closed; it may or may not have been applied." Links sent to a worker are now numbered, a relink request says which one the worker has, and the page attaches again only when the worker has its latest link, not while that link is on its way.
