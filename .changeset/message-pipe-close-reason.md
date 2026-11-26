---
"@statewalker/webrun-streams": minor
"@statewalker/webrun-streams-conformance": minor
---

`newMessagePipe`'s `target.close(reason?)` takes a reason: it becomes the pipe's signal reason and reaches the transport's `close`, so a relay can end one side with the reason the other ended with. The message pipe contract checks it (#218).
