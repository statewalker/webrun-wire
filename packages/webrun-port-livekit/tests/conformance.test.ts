import { describePortAdapter } from "@statewalker/webrun-port-conformance";
import { describe, it } from "vitest";
import { makeLiveKitPair } from "./make-livekit-pair.js";

const isBrowser =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { window?: unknown }).window !== "undefined";
const hasLiveKitEnv =
  typeof process !== "undefined" &&
  Boolean(
    process.env?.WEBRUN_PORT_LIVEKIT_URL &&
      process.env?.WEBRUN_PORT_LIVEKIT_TOKEN_ALICE &&
      process.env?.WEBRUN_PORT_LIVEKIT_TOKEN_BOB,
  );

if (isBrowser && hasLiveKitEnv) {
  describePortAdapter("webrun-port-livekit", makeLiveKitPair);
} else {
  describe.skip("webrun-port-livekit (browser + Docker required)", () => {
    it("skipped — run via pnpm test:browser on a host with Docker", () => {});
  });
}
