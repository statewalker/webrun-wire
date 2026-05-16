/// <reference types="vite/client" />

/**
 * Constants shared between the server-page, client-page, and the launcher.
 *
 * LiveKit dev-mode uses well-known credentials (`devkey` / `secret`) so the
 * token service can hard-code them without a per-deployment secret bundle.
 * For production you'd inject the API key + secret as env vars and never
 * ship them to the browser.
 */
export const LIVEKIT_URL =
  import.meta.env.VITE_LIVEKIT_URL ?? "ws://localhost:7880";

export const TOKEN_SERVICE_URL =
  import.meta.env.VITE_TOKEN_SERVICE_URL ?? "http://localhost:9091";

/** Room both peers join. Hard-coded for the demo. */
export const DEMO_ROOM = "p2p-demo-room";

/**
 * Fixed identity for the server peer. The client looks for this identity in
 * the room's participant list and opens a `createLiveKitPort` against it.
 */
export const SERVER_IDENTITY = "site-server";
