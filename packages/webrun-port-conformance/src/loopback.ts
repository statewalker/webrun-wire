export interface PortPair {
  a: MessagePort;
  b: MessagePort;
  close(): Promise<void>;
}

export type MakePair = () => Promise<PortPair>;

export const makeLoopbackPair: MakePair = async () => {
  const { port1, port2 } = new MessageChannel();
  port1.start();
  port2.start();
  return {
    a: port1,
    b: port2,
    async close() {
      try {
        port1.close();
      } catch {}
      try {
        port2.close();
      } catch {}
    },
  };
};

export interface FaultyPortPair extends PortPair {
  dropConnection(): void;
}

export type MakeFaultyPair = () => Promise<FaultyPortPair>;
