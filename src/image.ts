import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./errors.js";
import { inspectGifBuffer } from "./gif.js";
import type { ImageMediaType, ImageMimeType } from "./types.js";

type ImageExtension = ".gif" | ".png" | ".jpg" | ".jpeg" | ".webp";

export interface ImageInfo {
  buffer: Buffer;
  type: ImageMediaType;
  mimeType: ImageMimeType;
  extension: ImageExtension;
  bytes: number;
  width: number;
  height: number;
  frames?: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export function inspectPngBuffer(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ValidationError("The file does not have a valid PNG signature.");
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new ValidationError("The PNG does not start with an IHDR chunk.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) throw new ValidationError("The PNG has invalid dimensions.");
  return { width, height };
}

export function inspectJpegBuffer(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new ValidationError("The file does not have a valid JPEG signature.");
  }

  let offset = 2;
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    offset += 1;

    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > buffer.length) throw new ValidationError("Malformed JPEG segment.");
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      throw new ValidationError("Malformed JPEG segment.");
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) throw new ValidationError("Malformed JPEG frame header.");
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) throw new ValidationError("The JPEG has invalid dimensions.");
      return { width, height };
    }
    offset += segmentLength;
  }
  throw new ValidationError("The JPEG contains no supported frame header.");
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return (buffer[offset] ?? 0) | ((buffer[offset + 1] ?? 0) << 8) | ((buffer[offset + 2] ?? 0) << 16);
}

export function inspectWebpBuffer(buffer: Buffer): { width: number; height: number } {
  if (
    buffer.length < 20 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    throw new ValidationError("The file does not have a valid WebP signature.");
  }
  const declaredEnd = buffer.readUInt32LE(4) + 8;
  if (declaredEnd > buffer.length) throw new ValidationError("The WebP file is truncated.");

  let offset = 12;
  while (offset + 8 <= declaredEnd) {
    const chunkType = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const chunkEnd = dataOffset + chunkSize;
    if (chunkEnd > declaredEnd) throw new ValidationError("Malformed WebP chunk.");

    let width: number | undefined;
    let height: number | undefined;
    if (chunkType === "VP8X") {
      if (chunkSize < 10) throw new ValidationError("Malformed WebP VP8X header.");
      width = readUInt24LE(buffer, dataOffset + 4) + 1;
      height = readUInt24LE(buffer, dataOffset + 7) + 1;
    } else if (chunkType === "VP8L") {
      if (chunkSize < 5 || buffer[dataOffset] !== 0x2f) {
        throw new ValidationError("Malformed lossless WebP header.");
      }
      const dimensions = buffer.readUInt32LE(dataOffset + 1);
      width = (dimensions & 0x3fff) + 1;
      height = ((dimensions >>> 14) & 0x3fff) + 1;
    } else if (chunkType === "VP8 ") {
      if (
        chunkSize < 10 ||
        buffer[dataOffset + 3] !== 0x9d ||
        buffer[dataOffset + 4] !== 0x01 ||
        buffer[dataOffset + 5] !== 0x2a
      ) {
        throw new ValidationError("Malformed lossy WebP header.");
      }
      width = buffer.readUInt16LE(dataOffset + 6) & 0x3fff;
      height = buffer.readUInt16LE(dataOffset + 8) & 0x3fff;
    }

    if (width !== undefined && height !== undefined) {
      if (width === 0 || height === 0) throw new ValidationError("The WebP has invalid dimensions.");
      return { width, height };
    }
    offset = chunkEnd + (chunkSize % 2);
  }
  throw new ValidationError("The WebP contains no supported image header.");
}

export async function inspectImage(
  filePath: string,
  requireMatchingExtension: boolean,
): Promise<ImageInfo> {
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    throw new ValidationError(`Image does not exist: ${filePath}`);
  }
  if (!fileStats.isFile()) throw new ValidationError(`Image is not a regular file: ${filePath}`);
  const buffer = await readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();

  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    if (requireMatchingExtension && extension !== ".gif") {
      throw new ValidationError("A GIF image must use the .gif extension.");
    }
    return {
      buffer,
      type: "gif",
      mimeType: "image/gif",
      extension: ".gif",
      bytes: fileStats.size,
      ...inspectGifBuffer(buffer),
    };
  }

  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (requireMatchingExtension && extension !== ".png") {
      throw new ValidationError("A PNG image must use the .png extension.");
    }
    return {
      buffer,
      type: "png",
      mimeType: "image/png",
      extension: ".png",
      bytes: fileStats.size,
      ...inspectPngBuffer(buffer),
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    if (requireMatchingExtension && extension !== ".jpg" && extension !== ".jpeg") {
      throw new ValidationError("A JPEG image must use the .jpg or .jpeg extension.");
    }
    return {
      buffer,
      type: "jpeg",
      mimeType: "image/jpeg",
      extension: extension === ".jpeg" ? ".jpeg" : ".jpg",
      bytes: fileStats.size,
      ...inspectJpegBuffer(buffer),
    };
  }

  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    if (requireMatchingExtension && extension !== ".webp") {
      throw new ValidationError("A WebP image must use the .webp extension.");
    }
    return {
      buffer,
      type: "webp",
      mimeType: "image/webp",
      extension: ".webp",
      bytes: fileStats.size,
      ...inspectWebpBuffer(buffer),
    };
  }
  throw new ValidationError("The image must be a valid PNG, JPEG, WebP, or GIF file.");
}

export function isRemoteImage(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function normalizeImageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Image must be a direct HTTPS URL.");
  }
  if (value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new ValidationError("Image must be a direct HTTPS URL without credentials or a fragment (maximum 2048 characters).");
  }
  return url.toString();
}

export async function inspectRemoteImage(
  value: string,
  directory: string,
  maximumBytes: number,
  timeoutSeconds = 60,
): Promise<ImageInfo & { sourcePath: string; publicUrl: string }> {
  const publicUrl = normalizeImageUrl(value);
  let current = publicUrl;
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        headers: { Accept: "image/png,image/jpeg,image/webp,image/gif", "User-Agent": "satomi/0.1" },
        redirect: "manual",
        signal,
      });
    } catch {
      throw new ValidationError(signal.aborted ? "Image download timed out." : "Image URL could not be downloaded.");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new ValidationError("Image URL has an invalid or excessive redirect chain.");
      current = normalizeImageUrl(new URL(location, current).toString());
      continue;
    }
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!response.ok || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime ?? "")) {
      await response.body?.cancel();
      throw new ValidationError(`Image URL must return an image (HTTP ${response.status}, Content-Type ${mime ?? "none"}).`);
    }
    if (Number(response.headers.get("content-length")) > maximumBytes) {
      await response.body?.cancel();
      throw new ValidationError("Remote image exceeds the download size limit.");
    }
    if (!response.body) throw new ValidationError("Image URL returned an empty body.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maximumBytes) throw new ValidationError("Remote image exceeds the download size limit.");
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (signal.aborted) throw new ValidationError("Image download timed out.");
      throw error;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    await mkdir(directory, { recursive: true });
    const sourcePath = path.join(directory, "remote-image");
    await writeFile(sourcePath, Buffer.concat(chunks), { mode: 0o600 });
    try {
      const image = await inspectImage(sourcePath, false);
      if (image.mimeType !== mime) throw new ValidationError("Image Content-Type does not match its contents.");
      return { ...image, sourcePath, publicUrl };
    } catch (error) {
      await rm(sourcePath, { force: true });
      throw error;
    }
  }
  throw new ValidationError("Image URL exceeded five redirects.");
}
