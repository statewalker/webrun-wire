---
"@statewalker/webrun-http-browser": minor
---

Correct spellings: `newInvocationChannel` is exported, with `newInvokationChannel` kept as a deprecated alias. The internal stream channel's `recieveAll` and the module `src/http/http-send-recieve.ts` are renamed to `receiveAll` and `http-send-receive.ts` (neither was reachable through the package's exports map).
