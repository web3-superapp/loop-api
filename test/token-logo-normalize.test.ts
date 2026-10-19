import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  normalizeTokenLogo,
  tokenLogoNormalizedSize,
} from "../src/features/market/token-logo-normalize.js";
import { logoPng } from "./token-logo-fakes.js";

/** Decision 0161 §1: every stored logo is a 128 x 128 WebP with alpha. */

async function decode(bytes: Buffer) {
  return sharp(bytes).metadata();
}

describe("normalizeTokenLogo (Decision 0161)", () => {
  it("turns PNG, JPEG, GIF and WebP of any size into a 128 x 128 WebP (libwebp drops the alpha plane only when every pixel is opaque)", async () => {
    const base = sharp({
      create: {
        width: 300,
        height: 300,
        channels: 4,
        background: { r: 10, g: 200, b: 30, alpha: 0.4 },
      },
    });
    const inputs = [
      await base.clone().png().toBuffer(),
      await base.clone().jpeg().toBuffer(),
      await base.clone().gif().toBuffer(),
      await base.clone().webp().toBuffer(),
      await logoPng({ width: 16, height: 16 }),
      await logoPng({ width: 2000, height: 2000 }),
    ];
    for (const input of inputs) {
      const output = await normalizeTokenLogo(input);
      expect(output).not.toBeNull();
      const metadata = await decode(output as Buffer);
      expect(metadata).toMatchObject({
        format: "webp",
        width: tokenLogoNormalizedSize,
        height: tokenLogoNormalizedSize,
      });
      expect((output as Buffer).length).toBeLessThan(32 * 1024);
    }
  });

  it("keeps transparency and pads a non-square picture with transparent pixels instead of cropping", async () => {
    const wide = await sharp({
      create: {
        width: 400,
        height: 100,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const output = await normalizeTokenLogo(wide);
    const { data, info } = await sharp(output as Buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number): number =>
      data[(y * info.width + x) * info.channels + 3] ?? -1;
    // Top-left corner is padding (transparent), the centre is the picture.
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(64, 64)).toBe(255);

    const translucent = await normalizeTokenLogo(await logoPng({ alpha: 0.5 }));
    const raw = await sharp(translucent as Buffer)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = raw.data[(64 * raw.info.width + 64) * raw.info.channels + 3];
    expect(alpha).toBeGreaterThan(110);
    expect(alpha).toBeLessThan(145);
  });

  it("answers null for empty, truncated, SVG, non-image and over-2048² input", async () => {
    const good = await logoPng();
    expect(
      await normalizeTokenLogo(await logoPng({ width: 3000, height: 3000 })),
    ).toBeNull();
    for (const input of [
      Buffer.alloc(0),
      good.subarray(0, 40),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from("not an image at all"),
    ]) {
      expect(await normalizeTokenLogo(input)).toBeNull();
    }
  });
});
