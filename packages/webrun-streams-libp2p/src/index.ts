export {
  type ConnectionContext,
  type ConnectLibp2pParams,
  connect,
  DEFAULT_PROTOCOL,
  type ServeConnectionsHandler,
  type ServeLibp2pParams,
  serve,
  serveConnections,
} from "./connect-serve.js";
export {
  DEFAULT_DRAIN_TIMEOUT_MS,
  type DuplexOverStreamOptions,
  duplexOverStream,
} from "./duplex-over-stream.js";
