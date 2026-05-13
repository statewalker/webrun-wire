import msgpack from "@ygoe/msgpack";
import { encodeMessage, FrameReassembler } from "./framing.js";
import { type ByteLike, normalizeToUint8Array } from "./normalize.js";

const { serialize, deserialize } = msgpack;

export interface BytesTransport {
  postChunk(bytes: Uint8Array): void;
  onChunk(handler: (bytes: Uint8Array) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): void;
  mtu: number;
}

const STRUCTURED_CLONE_PREFIX = 0x02;
const RAW_BYTES_PREFIX = 0x03;

export function bindBytesToPort(transport: BytesTransport): MessagePort {
  const { port1, port2 } = new MessageChannel();

  let closed = false;
  let pendingSend: Promise<void> = Promise.resolve();
  const reassembler = new FrameReassembler();

  const send = (envelope: Uint8Array) => {
    pendingSend = pendingSend.then(async () => {
      if (closed) return;
      for (const frame of encodeMessage(envelope, transport.mtu)) {
        transport.postChunk(frame);
      }
    });
  };

  const handleOutbound = async (event: MessageEvent) => {
    if (closed) return;
    const data = event.data;
    if (data instanceof Uint8Array) {
      const env = new Uint8Array(data.byteLength + 1);
      env[0] = RAW_BYTES_PREFIX;
      env.set(data, 1);
      send(env);
      return;
    }
    if (isByteLike(data)) {
      const normalised = await normalizeToUint8Array(data as ByteLike);
      const env = new Uint8Array(normalised.byteLength + 1);
      env[0] = RAW_BYTES_PREFIX;
      env.set(normalised, 1);
      send(env);
      return;
    }
    let encoded: Uint8Array;
    try {
      encoded = serialize(data);
    } catch (err) {
      port2.postMessage({ __webrunPortCoreError: String(err) });
      return;
    }
    const env = new Uint8Array(encoded.byteLength + 1);
    env[0] = STRUCTURED_CLONE_PREFIX;
    env.set(encoded, 1);
    send(env);
  };

  port2.addEventListener("message", handleOutbound as unknown as EventListener);
  port2.start();

  const offChunk = transport.onChunk((chunk) => {
    if (closed) return;
    let message: Uint8Array | null;
    try {
      message = reassembler.push(chunk);
    } catch (err) {
      port2.postMessage({ __webrunPortCoreError: String(err) });
      return;
    }
    if (message === null) return;
    if (message.byteLength < 1) return;
    const prefix = message[0];
    const body = message.subarray(1);
    if (prefix === RAW_BYTES_PREFIX) {
      port2.postMessage(new Uint8Array(body));
      return;
    }
    if (prefix === STRUCTURED_CLONE_PREFIX) {
      try {
        port2.postMessage(deserialize(body));
      } catch (err) {
        port2.postMessage({ __webrunPortCoreError: String(err) });
      }
      return;
    }
  });

  const offClose = transport.onClose(() => {
    if (closed) return;
    closed = true;
    offChunk();
    offClose();
    try {
      port2.close();
    } catch {
      // ignore
    }
  });

  const originalClose = port1.close.bind(port1);
  port1.close = () => {
    if (closed) {
      originalClose();
      return;
    }
    closed = true;
    offChunk();
    offClose();
    try {
      transport.close();
    } catch {
      // ignore
    }
    try {
      port2.close();
    } catch {
      // ignore
    }
    originalClose();
  };

  return port1;
}

function isByteLike(data: unknown): boolean {
  return (
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    (typeof Blob !== "undefined" && data instanceof Blob) ||
    typeof data === "string"
  );
}
