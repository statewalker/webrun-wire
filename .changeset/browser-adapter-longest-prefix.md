---
"@statewalker/webrun-http-browser": patch
---

`SwHttpAdapter`: a request goes to the handler of the longest registered prefix (not the first registered one), prefixes match only on whole path segments (`demo/api` no longer serves `/demo/apiary`), and `remove()` of a registration replaced by a newer one of the same prefix no longer deletes the newer handler.
