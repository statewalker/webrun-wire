import { Room } from "livekit-client";
import { LIVEKIT_URL, TOKEN_SERVICE_URL } from "./config.js";

interface TokenResponse {
  token: string;
  url: string;
  identity: string;
  room: string;
}

/**
 * Ask the token service for a signed JWT bound to `identity` + `room`. The
 * launcher boots the service on `TOKEN_SERVICE_URL` (default
 * `http://localhost:9091`); it uses livekit-server-sdk to mint tokens with
 * the well-known dev API key/secret.
 */
export async function fetchToken(identity: string, room: string): Promise<TokenResponse> {
  const url = new URL("/token", TOKEN_SERVICE_URL);
  url.searchParams.set("identity", identity);
  url.searchParams.set("room", room);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`token service: HTTP ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Fetch a token and connect a fresh LiveKit `Room` with it. Resolves once the
 * room is in the `connected` state — at that point the local participant is
 * registered and `room.remoteParticipants` is populated with anyone already
 * in the room.
 */
export async function connectLiveKitRoom(identity: string, room: string): Promise<Room> {
  const { token } = await fetchToken(identity, room);
  const liveRoom = new Room();
  await liveRoom.connect(LIVEKIT_URL, token);
  return liveRoom;
}
