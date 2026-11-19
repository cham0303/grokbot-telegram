import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { singleFlight } from "../src/single-flight.js";

describe("singleFlight", () => {
  it("runs one connect while overlapping callers wait on it", async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = singleFlight(async () => {
      started += 1;
      await gate;
    });
    const first = connect();
    const second = connect();
    await Promise.resolve();
    assert.equal(started, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(started, 1);
    await connect();
    assert.equal(started, 2);
  });
});
