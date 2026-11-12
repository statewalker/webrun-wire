import type { WebSocketLike } from "./websocket-like.js";

export function messageTargetOverWebSocket(_ws: WebSocketLike): never {
  throw new Error("not implemented");
}
export async function openWebSocket(_p: unknown): Promise<never> {
  throw new Error("not implemented");
}
