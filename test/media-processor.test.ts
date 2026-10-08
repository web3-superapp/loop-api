import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  mediaAbsoluteUrl,
  mediaEtag,
  avatarRefMediaId,
  logoRefMediaId,
} from "../src/features/media/media-contract.js";
import {
  MediaRejectedError,
  processMediaUpload,
  sniffMediaFormat,
} from "../src/features/media/media-processor.js";

/** Decision 0095: input sniffing and the 512x512 WebP re-encode. */

async function image(
  format: "jpeg" | "png" | "webp",
  width: number,
  height: number,
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#336699" },
  })
    .toFormat(format)
    .toBuffer();
}

async function rejection(input: Buffer): Promise<string> {
  try {
    await processMediaUpload(input);
  } catch (error) {
    if (error instanceof MediaRejectedError) {
      return error.reasonCode;
    }
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("media processor (Decision 0095)", () => {
  it("sniffs JPEG, PNG, WebP, and HEIF brands by content only", async () => {
    expect(sniffMediaFormat(await image("jpeg", 64, 64))).toBe("jpeg");
    expect(sniffMediaFormat(await image("png", 64, 64))).toBe("png");
    expect(sniffMediaFormat(await image("webp", 64, 64))).toBe("webp");
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypheic", "latin1"),
      Buffer.alloc(16),
    ]);
    expect(sniffMediaFormat(heic)).toBe("heic");
    const avif = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypavif", "latin1"),
      Buffer.alloc(16),
    ]);
    expect(sniffMediaFormat(avif)).toBeNull();
    expect(sniffMediaFormat(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffMediaFormat(Buffer.from("<svg/>"))).toBeNull();
  });

  it("re-encodes every accepted format to a 512x512 cover WebP without metadata", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      const processed = await processMediaUpload(await image(format, 900, 300));
      expect(processed.width).toBe(512);
      expect(processed.height).toBe(512);
      expect(processed.inputFormat).toBe(format);
      expect(processed.sha256).toMatch(/^[0-9a-f]{64}$/);
      const metadata = await sharp(processed.bytes).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.exif).toBeUndefined();
    }
  });

  it("rejects small, empty, unsupported, undecodable, and oversized input with reason codes", async () => {
    expect(await rejection(await image("png", 63, 400))).toBe(
      "MEDIA_DIMENSIONS_TOO_SMALL",
    );
    expect(await rejection(Buffer.alloc(0))).toBe("MEDIA_TYPE_UNSUPPORTED");
    expect(await rejection(Buffer.from("not an image"))).toBe(
      "MEDIA_TYPE_UNSUPPORTED",
    );
    expect(
      await rejection(
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(40, 7),
        ]),
      ),
    ).toBe("MEDIA_DECODE_FAILED");
    expect(
      await rejection(
        Buffer.concat([
          Buffer.from([0, 0, 0, 24]),
          Buffer.from("ftypheic", "latin1"),
          Buffer.alloc(64),
        ]),
      ),
    ).toBe("MEDIA_DECODE_FAILED");
    expect(await rejection(Buffer.alloc(5 * 1024 * 1024 + 1, 0xff))).toBe(
      "MEDIA_TOO_LARGE",
    );
  });

  it("parses media refs and builds URLs and ETags", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(avatarRefMediaId(`avatar:media/${id}`)).toBe(id);
    expect(avatarRefMediaId(`logo:media/${id}`)).toBeNull();
    expect(avatarRefMediaId("avatar:preset/monogram")).toBeNull();
    expect(
      avatarRefMediaId("avatar:media/ABCDEF22-2222-4222-8222-222222222222"),
    ).toBeNull();
    expect(logoRefMediaId(`logo:media/${id}`)).toBe(id);
    expect(mediaAbsoluteUrl("https://api.test//", id)).toBe(
      `https://api.test/v2/media/${id}.webp`,
    );
    expect(mediaEtag("ab".repeat(32))).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });
});
