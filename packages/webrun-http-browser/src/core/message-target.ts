// Moved to @statewalker/webrun-streams so webrun-rpc and webrun-streams-port
// can use these without depending on this package. Re-exported here so the
// five internal importers, and this package's public API, are unchanged.
export type {
  MessageListener,
  MessageSink,
  MessageSource,
  MessageTarget,
} from "@statewalker/webrun-streams";
