import { AccessToken } from "livekit-server-sdk";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

/**
 * Browser-mode globalSetup: spin a `livekit/livekit-server:dev` container,
 * mint participant tokens for `alice` and `bob`, and expose the WS URL plus
 * tokens via env vars so the browser-side `makeLiveKitPair` can connect.
 *
 * Requires Docker. Skips gracefully (env var unset) when Docker is
 * unavailable; the conformance suite then logs a skip message instead of
 * failing the run.
 */

const DEV_API_KEY = "devkey";
const DEV_API_SECRET = "secret";
let container: StartedTestContainer | null = null;

export default async function setup() {
  try {
    container = await new GenericContainer("livekit/livekit-server:latest")
      .withCommand([
        "--dev",
        "--bind",
        "0.0.0.0",
        "--rtc-port-tcp",
        "7881",
        "--rtc-port-udp",
        "50000-50100",
      ])
      .withExposedPorts(7880)
      .withStartupTimeout(60_000)
      .start();
    const host = container.getHost();
    const port = container.getMappedPort(7880);
    const url = `ws://${host}:${port}`;
    process.env.WEBRUN_PORT_LIVEKIT_URL = url;
    process.env.WEBRUN_PORT_LIVEKIT_TOKEN_ALICE = await mintToken("alice");
    process.env.WEBRUN_PORT_LIVEKIT_TOKEN_BOB = await mintToken("bob");
  } catch (err) {
    // Docker unavailable or container failed — leave env vars unset so the
    // conformance test skips with a documented message.
    console.warn(
      `[webrun-port-livekit] LiveKit container unavailable, browser conformance will be skipped: ${(err as Error).message}`,
    );
  }

  return async () => {
    try {
      await container?.stop();
    } catch {
      /* ignore */
    }
  };
}

async function mintToken(identity: string): Promise<string> {
  const at = new AccessToken(DEV_API_KEY, DEV_API_SECRET, { identity });
  at.addGrant({
    roomJoin: true,
    room: "webrun-port-conformance",
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return await at.toJwt();
}
