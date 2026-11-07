---
"@statewalker/webrun-http-browser": patch
---

The same-origin dispatcher takes a `key` option, `(url, scope) => key | undefined`, which decides the key a url belongs to for `dispatch()` (and so a handler's `service.fetch`), for sockets, and for `fetch` events of this origin's urls. The default, now exported as `scopeKey`, is the first path segment under the scope, as before. A host with another layout gives its own: a site at the origin's root, or projects under a base path. A key for another origin's url, such as an internal host its handlers call each other on, serves handlers' `service.fetch` and sockets. Those used to go to the network, because a url outside the scope had no key. A page's own `fetch` to that origin stays the browser's. `scopeKey` gives no key for a segment that does not decode, rather than throwing.
