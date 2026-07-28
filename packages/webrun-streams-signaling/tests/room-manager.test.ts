import { describe, expect, it } from "vitest";
import { RoomManager } from "../src/room-manager.js";
import type { RoomLike } from "../src/types.js";
import { readOne } from "./helpers.js";
import { MockRoom, RoomBus } from "./mocks/room-bus.js";

describe("RoomManager", () => {
  it("observes joiners, opens per-participant channels, and cleans up on leave", async () => {
    const bus = new RoomBus();
    const make = (identity: string) =>
      new RoomManager({
        url: "ws://mock",
        getToken: () => Promise.resolve(`token-${identity}`),
        roomFactory: (): RoomLike => new MockRoom(identity, bus),
      });

    const a = make("A");
    const b = make("B");

    await a.join("room1");

    // Start observing before B joins; the joiner must be delivered live.
    const iterator = a.participants()[Symbol.asyncIterator]();
    const firstJoin = iterator.next();

    await b.join("room1");

    const { value: joined } = await firstJoin;
    expect(joined).toBe("B");

    const chA = await a.channelTo("B");
    const chB = await b.channelTo("A");

    chA.send(new Uint8Array([5, 5]));
    expect(await readOne(chB)).toEqual(new Uint8Array([5, 5]));

    chB.send(new Uint8Array([6]));
    expect(await readOne(chA)).toEqual(new Uint8Array([6]));

    // leave() ends the participants stream and disconnects.
    await a.leave();
    const after = await iterator.next();
    expect(after.done).toBe(true);

    await b.leave();
  });

  it("seeds already-present participants for a late joiner", async () => {
    const bus = new RoomBus();
    const make = (identity: string) =>
      new RoomManager({
        url: "ws://mock",
        getToken: () => Promise.resolve("t"),
        roomFactory: (): RoomLike => new MockRoom(identity, bus),
      });

    const a = make("A");
    const b = make("B");
    await a.join("room1");
    await b.join("room1");

    // B joined after A, so A is already present: participants() yields "A".
    const iterator = b.participants()[Symbol.asyncIterator]();
    const { value } = await iterator.next();
    expect(value).toBe("A");

    await a.leave();
    await b.leave();
  });
});
