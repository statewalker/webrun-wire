import type { ByteChannel } from "@statewalker/webrun-streams";

/** Read the next byte chunk from a channel's `recv`. */
export async function readOne(channel: ByteChannel): Promise<Uint8Array> {
  const iterator = channel.recv[Symbol.asyncIterator]();
  const { value, done } = await iterator.next();
  if (done || !value) throw new Error("channel closed before a chunk arrived");
  return value;
}
