import { createHash } from "node:crypto";

import sharp, { type OutputInfo } from "sharp";

import {
  mediaMaximumInputPixels,
  mediaMaximumUploadBytes,
  mediaMinimumInputSide,
  mediaOutputQuality,
  mediaOutputSize,
  mediaReasonCodes,
} from "./media-contract.js";

/**
 * Turns one uploaded picture into the stored 512 x 512 WebP (Decision 0095).
 *
 * The input type is decided by its magic bytes only; the multipart
 * `Content-Type` and file name are never trusted. Metadata (EXIF, GPS, ICC
 * comments) is dropped by the re-encode; EXIF orientation is applied first.
 */

export type MediaInputFormat = "jpeg" | "png" | "webp" | "heic";

export interface ProcessedMedia {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly inputFormat: MediaInputFormat;
}

export class MediaRejectedError extends Error {
  readonly code = "media_rejected";

  constructor(
    readonly reasonCode: (typeof mediaReasonCodes)[keyof typeof mediaReasonCodes],
  ) {
    super("The uploaded media was rejected");
    this.name = "MediaRejectedError";
  }
}

const heifBrands: ReadonlySet<string> = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1",
]);

export function sniffMediaFormat(input: Buffer): MediaInputFormat | null {
  if (
    input.length >= 3 &&
    input[0] === 0xff &&
    input[1] === 0xd8 &&
    input[2] === 0xff
  ) {
    return "jpeg";
  }
  if (
    input.length >= 8 &&
    input
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }
  if (
    input.length >= 12 &&
    input.toString("latin1", 0, 4) === "RIFF" &&
    input.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (
    input.length >= 12 &&
    input.toString("latin1", 4, 8) === "ftyp" &&
    heifBrands.has(input.toString("latin1", 8, 12))
  ) {
    return "heic";
  }
  return null;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function processMediaUpload(
  input: Buffer,
): Promise<ProcessedMedia> {
  if (input.length === 0) {
    throw new MediaRejectedError(mediaReasonCodes.typeUnsupported);
  }
  if (input.length > mediaMaximumUploadBytes) {
    throw new MediaRejectedError(mediaReasonCodes.tooLarge);
  }
  const inputFormat = sniffMediaFormat(input);
  if (inputFormat === null) {
    throw new MediaRejectedError(mediaReasonCodes.typeUnsupported);
  }
  const options = {
    limitInputPixels: mediaMaximumInputPixels,
    failOn: "error",
  } as const;
  let width: number;
  let height: number;
  try {
    const metadata = await sharp(input, options).metadata();
    width = metadata.width;
    height = metadata.height;
  } catch {
    throw new MediaRejectedError(mediaReasonCodes.decodeFailed);
  }
  if (width < mediaMinimumInputSide || height < mediaMinimumInputSide) {
    throw new MediaRejectedError(mediaReasonCodes.dimensionsTooSmall);
  }
  let output: { data: Buffer; info: OutputInfo };
  try {
    output = await sharp(input, options)
      .rotate()
      .resize(mediaOutputSize, mediaOutputSize, { fit: "cover" })
      .webp({ quality: mediaOutputQuality })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new MediaRejectedError(mediaReasonCodes.decodeFailed);
  }
  return Object.freeze({
    bytes: output.data,
    width: output.info.width,
    height: output.info.height,
    sha256: sha256Hex(output.data),
    inputFormat,
  });
}
