---
"@statewalker/webrun-streams": patch
"@statewalker/webrun-rpc": patch
---

Module-level constants (text encoders, the close-signal table) are annotated pure, so bundlers drop them with the code that uses them.
