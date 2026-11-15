---
"@statewalker/webrun-streams": minor
"@statewalker/webrun-rpc": minor
"@statewalker/webrun-http-browser": minor
---

**Breaking:** the deprecated misspelt aliases are removed (#150). Import the correctly spelt names instead: `receiveIterator` (was `recieveIterator`) from webrun-streams, `receive` and `ReceiveOptions` (were `recieve` and `RecieveOptions`) from webrun-rpc, and `newInvocationChannel` (was `newInvokationChannel`) from webrun-http-browser. webrun-streams' dormant `flow-control.ts` stays until #153 is decided.
