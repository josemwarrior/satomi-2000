import { describe, expect, it } from "vitest";
import { inspectGifBuffer } from "./gif.js";

const singleFrame = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function animatedGif(): Buffer {
  const descriptor = singleFrame.indexOf(0x2c);
  return Buffer.concat([
    singleFrame.subarray(0, singleFrame.length - 1),
    singleFrame.subarray(descriptor, singleFrame.length - 1),
    Buffer.from([0x3b]),
  ]);
}

describe("GIF inspection", () => {
  it("reads dimensions and frame count without external tools", () => {
    expect(inspectGifBuffer(animatedGif())).toEqual({ width: 1, height: 1, frames: 2 });
  });

  it("rejects a file with a false GIF extension", () => {
    expect(() => inspectGifBuffer(Buffer.from("not a gif"))).toThrow(/too short|signature/);
  });
});
