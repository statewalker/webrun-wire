// A minimal MessageTarget over ONE libp2p byte stream.
//
// Wire format: every postMessage(bytes) becomes one frame = 4-byte big-endian
// length + bytes. (multiplexPort + msgpackCodec hand us one Uint8Array per
// envelope; msgpackCodec assumes a message-preserving transport, so we add the
// length prefix it deliberately omits.)
//
// BUFFERING — exactly how this adapter buffers:
//  * Write side: postMessage() is synchronous (the MessageTarget contract has no
//    way to say "wait"), so a frame is pushed onto `queue` (a plain JS array,
//    UNBOUNDED). A single pump drains the queue into `stream.send(frame)`; when
//    send() returns false (libp2p says writableNeedsDrain: yamux send window
//    exhausted or the connection's socket is full) the pump awaits the stream's
//    'drain' event before sending the next frame. So the adapter never grows
//    libp2p's own writeBuffer beyond one frame; all excess sits in `queue`,
//    which is measured (queuedBytes / maxQueuedBytes).
//  * Read side: listens to the stream's 'message' events (no async iterator,
//    so no extra pushable), reassembles frames in a Uint8ArrayList and
//    dispatches each one synchronously to the listeners. It never pauses the
//    stream: multiplexPort delivers synchronously and has no way to say "stop".
//  * Close: the MessageTarget interface has no close/error event, so a dead
//    stream cannot be reported to multiplexPort. `onClose` is an out-of-band
//    hook the benchmark may use ("wired" mode) to call mux.close() itself.
import { Uint8ArrayList } from "uint8arraylist";

export const adapterStats = {
  ports: 0,
  queuedBytes: 0,
  maxQueuedBytes: 0,
  framesOut: 0,
  framesIn: 0,
};

export function streamPort(stream, { onClose } = {}) {
  const listeners = new Set();
  const queue = [];
  let pumping = false;
  let closed = false;
  adapterStats.ports++;

  const waitDrain = () =>
    new Promise((resolve, reject) => {
      const done = () => {
        stream.removeEventListener("drain", onDrain);
        stream.removeEventListener("close", onCl);
      };
      const onDrain = () => {
        done();
        resolve();
      };
      const onCl = (e) => {
        done();
        reject(e.error ?? new Error("stream closed"));
      };
      stream.addEventListener("drain", onDrain);
      stream.addEventListener("close", onCl);
    });

  const pump = async () => {
    pumping = true;
    try {
      while (queue.length > 0 && !closed) {
        const frame = queue.shift();
        adapterStats.queuedBytes -= frame.byteLength;
        adapterStats.framesOut++;
        if (!stream.send(frame)) await waitDrain();
      }
    } catch {
      markClosed();
    } finally {
      pumping = false;
    }
  };

  const markClosed = (err) => {
    if (closed) return;
    closed = true;
    for (const f of queue.splice(0)) adapterStats.queuedBytes -= f.byteLength;
    adapterStats.ports--;
    try {
      onClose?.(err);
    } catch {}
  };

  const buf = new Uint8ArrayList();
  stream.addEventListener("message", (evt) => {
    buf.append(evt.data);
    while (buf.byteLength >= 4) {
      const len = buf.getUint32(0);
      if (buf.byteLength < 4 + len) break;
      const data = buf.subarray(4, 4 + len);
      buf.consume(4 + len);
      adapterStats.framesIn++;
      const event = new MessageEvent("message", { data });
      for (const l of [...listeners]) {
        try {
          void l(event);
        } catch {}
      }
    }
  });
  stream.addEventListener("close", (e) => markClosed(e.error));

  return {
    stream,
    get queueLength() {
      return queue.length;
    },
    addEventListener(_t, l) {
      listeners.add(l);
    },
    removeEventListener(_t, l) {
      listeners.delete(l);
    },
    postMessage(msg) {
      if (closed) throw new Error("stream-port: closed");
      const bytes = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
      const frame = new Uint8Array(4 + bytes.byteLength);
      new DataView(frame.buffer).setUint32(0, bytes.byteLength);
      frame.set(bytes, 4);
      queue.push(frame);
      adapterStats.queuedBytes += frame.byteLength;
      if (adapterStats.queuedBytes > adapterStats.maxQueuedBytes)
        adapterStats.maxQueuedBytes = adapterStats.queuedBytes;
      if (!pumping) void pump();
    },
    async close() {
      markClosed();
      try {
        await stream.close();
      } catch {
        try {
          stream.abort(new Error("closed"));
        } catch {}
      }
    },
  };
}
