# @statewalker/webrun-streams-webrtc

## 0.2.0

### Minor Changes

- 67a481d: Flow control on each data channel. A sender waits while `bufferedAmount` is above 1 MiB (until `bufferedamountlow` at 256 KiB), and may have at most 4 MiB outstanding that the receiving consumer has not pulled; the receiver returns credit with a new `CREDIT` frame (0x03). A 100 MiB body no longer overflows the browser's send queue, and a slow reader stalls the sender instead of growing an unbounded queue. Wire change: both ends must run this version (an older peer never returns credit, so a newer sender stops after 4 MiB).

## 0.1.6

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-streams ^0.2.2 -> ^0.2.3

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-streams@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [c6dc18d]
  - @statewalker/webrun-streams@0.2.0

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-streams@0.1.1
