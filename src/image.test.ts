import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectImage,
  inspectJpegBuffer,
  inspectPngBuffer,
  inspectWebpBuffer,
} from "./image.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const jpeg = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  0xff, 0xd9,
]);

function extendedWebp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

const webp = extendedWebp(3, 2);
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("image input", () => {
  it("reads PNG dimensions from IHDR", () => {
    expect(inspectPngBuffer(png)).toEqual({ width: 1, height: 1 });
  });

  it("detects PNG by content and verifies its extension", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "satomi-image-"));
    temporaryPaths.push(directory);
    const imagePath = path.join(directory, "capture.png");
    await writeFile(imagePath, png);
    const image = await inspectImage(imagePath, true);
    expect(image.type).toBe("png");
    expect(image.mimeType).toBe("image/png");
  });

  it("rejects a PNG disguised with a GIF extension", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "satomi-image-"));
    temporaryPaths.push(directory);
    const imagePath = path.join(directory, "capture.gif");
    await writeFile(imagePath, png);
    await expect(inspectImage(imagePath, true)).rejects.toThrow(/must use the \.png extension/);
  });

  it("reads JPEG dimensions from a start-of-frame segment", () => {
    expect(inspectJpegBuffer(jpeg)).toEqual({ width: 3, height: 2 });
  });

  it.each([".jpg", ".jpeg"])("accepts JPEG with a %s extension", async (extension) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "satomi-image-"));
    temporaryPaths.push(directory);
    const imagePath = path.join(directory, `capture${extension}`);
    await writeFile(imagePath, jpeg);
    const image = await inspectImage(imagePath, true);
    expect(image.type).toBe("jpeg");
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.extension).toBe(extension);
  });

  it("reads WebP dimensions from a VP8X chunk and detects its MIME type", async () => {
    expect(inspectWebpBuffer(webp)).toEqual({ width: 3, height: 2 });
    const directory = await mkdtemp(path.join(os.tmpdir(), "satomi-image-"));
    temporaryPaths.push(directory);
    const imagePath = path.join(directory, "capture.webp");
    await writeFile(imagePath, webp);
    const image = await inspectImage(imagePath, true);
    expect(image.type).toBe("webp");
    expect(image.mimeType).toBe("image/webp");
  });

  it("rejects a JPEG disguised with a PNG extension", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "satomi-image-"));
    temporaryPaths.push(directory);
    const imagePath = path.join(directory, "capture.png");
    await writeFile(imagePath, jpeg);
    await expect(inspectImage(imagePath, true)).rejects.toThrow(/\.jpg or \.jpeg extension/);
  });
});
