---
"@statewalker/webrun-http-browser": patch
---

A handler served over an HTTP link sees its requests at the right scheme. A request crosses the link as HTTP/1.1, whose origin-form target carries no scheme, and the answering end rebuilt every url as `http://`. On a page served over https, a handler therefore saw `http://host/…`, and `SwHttpAdapter`, which finds a handler by the base url it registered (`https://host/key/`), found none: every request to it answered "404 Error 404: Not found" (over http nothing showed). The answering end now rebuilds urls with the scheme of its own realm's `location` (http or https; `http` where there is none, as in Node), or with the new `HttpLinkOptions.scheme`.
