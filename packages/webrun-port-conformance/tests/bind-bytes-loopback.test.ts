import { bindBytesToPort } from "@statewalker/webrun-port-core";
import { describePortAdapter, type MakePair } from "../src/index.js";

// Use bindBytesToPort over a synthetic in-process byte transport — exercises
// the full port-core stack (normalize + framing + chunking + close convention)
// without any real transport.
function makeBytesTransportPair(mtu: number) {
  type Listener = (bytes: Uint8Array) => void;
  type CloseListener = () => void;

  const aToB: Listener[] = [];
  const bToA: Listener[] = [];
  const aCloseListeners: CloseListener[] = [];
  const bCloseListeners: CloseListener[] = [];
  let closed = false;

  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const fn of aCloseListeners) fn();
    for (const fn of bCloseListeners) fn();
  };

  const transportA = {
    postChunk(bytes: Uint8Array) {
      if (closed) return;
      const copy = new Uint8Array(bytes);
      for (const fn of aToB) {
        // Dispatch on a microtask boundary so handlers see ordered fan-out.
        queueMicrotask(() => fn(copy));
      }
    },
    onChunk(fn: Listener) {
      bToA.push(fn);
      return () => {
        const i = bToA.indexOf(fn);
        if (i >= 0) bToA.splice(i, 1);
      };
    },
    onClose(fn: CloseListener) {
      aCloseListeners.push(fn);
      return () => {
        const i = aCloseListeners.indexOf(fn);
        if (i >= 0) aCloseListeners.splice(i, 1);
      };
    },
    close: fireClose,
    mtu,
  };

  const transportB = {
    postChunk(bytes: Uint8Array) {
      if (closed) return;
      const copy = new Uint8Array(bytes);
      for (const fn of bToA) {
        queueMicrotask(() => fn(copy));
      }
    },
    onChunk(fn: Listener) {
      aToB.push(fn);
      return () => {
        const i = aToB.indexOf(fn);
        if (i >= 0) aToB.splice(i, 1);
      };
    },
    onClose(fn: CloseListener) {
      bCloseListeners.push(fn);
      return () => {
        const i = bCloseListeners.indexOf(fn);
        if (i >= 0) bCloseListeners.splice(i, 1);
      };
    },
    close: fireClose,
    mtu,
  };

  return { transportA, transportB };
}

const makeBindBytesPair: MakePair = async () => {
  // Smallish MTU to force chunking on bigger payloads — exercises framing.
  const { transportA, transportB } = makeBytesTransportPair(64 * 1024);
  const a = bindBytesToPort(transportA);
  const b = bindBytesToPort(transportB);
  return {
    a,
    b,
    async close() {
      try {
        a.close();
      } catch {}
      try {
        b.close();
      } catch {}
    },
  };
};

describePortAdapter("bind-bytes-to-port (synthetic transport)", makeBindBytesPair);
