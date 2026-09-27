---
"@statewalker/webrun-http-browser": patch
---

`SwPortHandler.rootUrl` resolves the scope against the worker's own url when
`serviceWorkerUrl` is given, instead of against `import.meta.url`. In a bundle
that is not an ES module (an IIFE, such as Eclipse Theia's esbuild frontend)
`import.meta.url` is undefined, so registering a handler threw `Invalid URL`
and the edge never started.
