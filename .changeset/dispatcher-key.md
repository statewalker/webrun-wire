---
"@statewalker/webrun-http-browser": patch
---

The same-origin dispatcher takes a `key` option, `(url, scope) => key | undefined`, which decides the key a url belongs to for `fetch` events, `dispatch()` and sockets alike. The default, now exported as `scopeKey`, is the first path segment under the scope, as before. A host with another layout gives its own: a site at the origin's root, projects under a base path, or urls on another origin that only its handlers call through `service.fetch`. Such urls used to go to the network, because a url outside the scope had no key.
