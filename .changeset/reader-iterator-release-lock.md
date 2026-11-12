---
"@statewalker/webrun-http-streams": patch
---

A body iterated for a fetch or a served response lets go of its stream's lock again however the iteration ends — torn down by `return()`, `throw()` or an abort, or failed — as before 0.4.4, so the stream is no longer left `locked`. The cancel is still started at once and not awaited. A body that fails on its own now fails the iteration once; later reads are done instead of failing again.
