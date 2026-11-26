# @statewalker/webrun-streams-chrome

## 0.1.0

### Minor Changes

- 10c546a: New package: `chromePortPipe` (a `chrome.runtime.Port` as a pipe of bytes, base64 frames, disconnect as its close signal), `messagePortPipe` (a `MessagePort` as a pipe, with a close message carrying the reason) and `relayPipes` (the content script's two-way relay, its ends linked), so `webrun-rpc`'s port stack runs between a page, its content script and the extension's service worker (#218).

### Patch Changes

- Updated dependencies [10c546a]
  - @statewalker/webrun-streams@0.7.0
