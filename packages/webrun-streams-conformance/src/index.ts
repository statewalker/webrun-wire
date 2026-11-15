export {
  type DescribeDuplexAdapterOptions,
  describeDuplexAdapter,
} from "./describe-duplex-adapter.js";
export {
  type DescribeMessagePipeOptions,
  describeMessagePipe,
  type MessagePipeHarness,
} from "./describe-message-pipe.js";
export {
  describePortMux,
  type MakePortMuxHarness,
  type PortMuxHarness,
} from "./describe-port-mux.js";
export {
  type ConnectServePair,
  type MakePair,
  makeLoopbackPair,
  type PairTuning,
} from "./loopback.js";
export { measureRunAhead, type RunAheadMeasurement } from "./run-ahead.js";
