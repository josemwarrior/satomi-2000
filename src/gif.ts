import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./errors.js";

export interface GifInfo {
  buffer: Buffer;
  bytes: number;
  width: number;
  height: number;
  frames: number;
}

function skipSubBlocks(buffer: Buffer, start: number): number {
  let offset = start;
  while (offset < buffer.length) {
    const length = buffer[offset];
    if (length === undefined) throw new ValidationError("Malformed GIF data.");
    offset += 1;
    if (length === 0) return offset;
    offset += length;
    if (offset > buffer.length) throw new ValidationError("Malformed GIF data.");
  }
  throw new ValidationError("Malformed GIF data.");
}

export function inspectGifBuffer(buffer: Buffer): Omit<GifInfo, "buffer" | "bytes"> {
  if (buffer.length < 14) throw new ValidationError("The GIF is too short to be valid.");
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    throw new ValidationError("The file MIME signature is not GIF87a or GIF89a.");
  }

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (width === 0 || height === 0) throw new ValidationError("The GIF has invalid dimensions.");

  const packed = buffer[10] ?? 0;
  let offset = 13;
  if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);

  let frames = 0;
  while (offset < buffer.length) {
    const marker = buffer[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset += 1;
      offset = skipSubBlocks(buffer, offset);
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 9 > buffer.length) throw new ValidationError("Malformed GIF image descriptor.");
      const imagePacked = buffer[offset + 8] ?? 0;
      offset += 9;
      if ((imagePacked & 0x80) !== 0) {
        offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
      }
      offset += 1;
      offset = skipSubBlocks(buffer, offset);
      frames += 1;
      continue;
    }
    throw new ValidationError("Malformed GIF block structure.");
  }

  if (frames === 0) throw new ValidationError("The GIF contains no image frames.");
  return { width, height, frames };
}

export async function inspectGif(filePath: string, requireExtension: boolean): Promise<GifInfo> {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    throw new ValidationError(`GIF does not exist: ${filePath}`);
  }
  if (!fileStats.isFile()) throw new ValidationError(`GIF is not a regular file: ${filePath}`);
  if (requireExtension && path.extname(filePath).toLowerCase() !== ".gif") {
    throw new ValidationError(`Expected a .gif file: ${filePath}`);
  }
  const buffer = await readFile(filePath);
  return { buffer, bytes: fileStats.size, ...inspectGifBuffer(buffer) };
}
