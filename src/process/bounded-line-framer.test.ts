import { describe, expect, it } from "vitest";
import { createBoundedLineFramer } from "./bounded-line-framer.js";

describe("bounded line framing", () => {
  it("preserves bytes, empty lines, and CR across arbitrary chunk boundaries", () => {
    const lines = [Buffer.from("漢😀\r"), Buffer.alloc(0), Buffer.from([0xff])];
    const wire = Buffer.concat(lines.flatMap((line) => [line, Buffer.from("\n")]));
    const framer = createBoundedLineFramer(8, "line too long");
    const received: Buffer[] = [];

    for (const byte of wire) {
      received.push(...framer.push(Buffer.from([byte])));
    }

    expect(received).toEqual(lines);
  });

  it("does not inspect a later oversized frame after its consumer retires", () => {
    const framer = createBoundedLineFramer(4, "line too long");
    const received: Buffer[] = [];

    for (const line of framer.push(Buffer.from("done\noversized"))) {
      received.push(line);
      break;
    }

    expect(received).toEqual([Buffer.from("done")]);
  });

  it("bounds individual lines across fragmented and coalesced chunks", () => {
    const framer = createBoundedLineFramer(4, "line too long");
    expect([...framer.push(Buffer.from("abcd\nab"))]).toEqual([Buffer.from("abcd")]);
    expect([...framer.push(Buffer.from("cd\n1234\n"))]).toEqual([
      Buffer.from("abcd"),
      Buffer.from("1234"),
    ]);
    expect(() => [...framer.push(Buffer.from("abcde"))]).toThrow("line too long");
  });

  it("keeps incomplete final bytes separate from delivered lines", () => {
    const framer = createBoundedLineFramer(4, "line too long");
    expect([...framer.push(Buffer.from("part"))]).toEqual([]);
    expect(framer.pendingByteLength).toBe(4);
    expect([...framer.push(Buffer.from("\ntail"))]).toEqual([Buffer.from("part")]);
    expect(framer.pendingByteLength).toBe(4);
    framer.clear();
    expect(framer.pendingByteLength).toBe(0);
  });
});
