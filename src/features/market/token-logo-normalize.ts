import sharp from "sharp";

/**
 * Normalised token logo (Decision 0161 §1).
 *
 * Every picture the logo proxy stores — fetched from an upstream or
 * uploaded by an operator — is re-encoded once into a 128 x 128 WebP with
 * its alpha channel kept, so the route answers a few kilobytes whatever the
 * upstream sent and no client is ever redirected to an upstream host
 * (Decision 0089's 256 KiB `302` is gone).
 *
 * - The input is decoded by `sharp` (already a dependency for
 *   `/v2/media`, Decision 0095). Only the raster types the proxy's
 *   signature sniff admits reach it (PNG, JPEG, GIF, WebP); SVG never does.
 * - The picture is fitted inside the square without cropping (`contain`),
 *   padded with transparent pixels; a smaller picture is enlarged so every
 *   row has the same size. An animated GIF / WebP keeps its first frame.
 * - EXIF orientation is applied, then all metadata is dropped.
 * - Anything sharp cannot decode, a picture above 2048 x 2048 pixels, a
 *   re-encode taking more than 5 s, and an output above the stored-size
 *   limit are "no picture" (`null`).
 */

export const tokenLogoNormalizedSize = 128;
export const tokenLogoNormalizedContentType = "image/webp" as const;
/** WebP quality of the colour channels; alpha is stored at full quality. */
export const tokenLogoNormalizedQuality = 85;
/** Largest input decoded (pixels); 2048 x 2048 is far above any logo. */
export const tokenLogoMaximumInputPixels = 2048 * 2048;
/** libvips time limit of one re-encode; a slower picture is "no picture". */
export const tokenLogoNormalizeTimeoutSeconds = 5;
/** Largest normalised output stored (the `token_logo_cache` byte check). */
export const tokenLogoMaximumStoredBytes = 256 * 1024;

export type TokenLogoNormalizer = (input: Buffer) => Promise<Buffer | null>;

export const normalizeTokenLogo: TokenLogoNormalizer = async (input) => {
  if (input.length === 0) {
    return null;
  }
  try {
    const output = await sharp(input, {
      limitInputPixels: tokenLogoMaximumInputPixels,
      failOn: "error",
      pages: 1,
    })
      .rotate()
      .resize(tokenLogoNormalizedSize, tokenLogoNormalizedSize, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .ensureAlpha()
      .webp({
        quality: tokenLogoNormalizedQuality,
        alphaQuality: 100,
        effort: 4,
      })
      .timeout({ seconds: tokenLogoNormalizeTimeoutSeconds })
      .toBuffer();
    if (output.length === 0 || output.length > tokenLogoMaximumStoredBytes) {
      return null;
    }
    return output;
  } catch {
    return null;
  }
};
