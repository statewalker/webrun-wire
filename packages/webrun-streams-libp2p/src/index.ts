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
export { duplexOverStream } from "./duplex-over-stream.js";
