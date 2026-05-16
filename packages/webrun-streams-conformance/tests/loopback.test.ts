import { describeDuplexAdapter, makeLoopbackPair } from "../src/index.js";

describeDuplexAdapter("loopback", makeLoopbackPair);
