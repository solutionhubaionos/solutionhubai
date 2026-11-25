/**
 * Prepares the client's logo for the deck. An opaque logo (a JPEG, or a PNG
 * with a white/coloured box) would otherwise paste a hard rectangle onto the
 * gradient; a logo can also carry transparent padding that makes the mark sit
 * small and off-centre. This removes the flat background around the mark,
 * makes it transparent, and crops the padding so the mark fills its box with
 * the right proportions.
 *
 * Server-side, via `@napi-rs/canvas`. The browser has already rasterised the
 * raw logo to a PNG (`src/lib/logo/rasterise.ts`); anything unreadable is
 * returned unchanged so an export never fails for a logo.
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";

/** The largest edge a stored logo is resampled to. */
const MAX_EDGE = 1024;
/** Per-channel distance under which a pixel counts as the background colour. */
const TOLERANCE = 26;
/** Alpha at or below this is treated as empty. */
const EMPTY_ALPHA = 16;

/** The raw bytes of a data URL, or null when it is not a readable data URL. */
function payloadBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  try {
    if (/;base64/i.test(meta)) return new Uint8Array(Buffer.from(body, "base64"));
    return new Uint8Array(Buffer.from(decodeURIComponent(body)));
  } catch {
    return null;
  }
}

/**
 * Returns a transparent, tightly cropped PNG data URL for the logo. On any
 * failure the original data URL is returned, so a bad logo degrades to the
 * previous behaviour rather than breaking the deck.
 */
export async function cleanClientLogo(dataUrl: string): Promise<string> {
  const bytes = payloadBytes(dataUrl);
  if (!bytes || bytes.length === 0) return dataUrl;

  let image: Awaited<ReturnType<typeof loadImage>>;
  try {
    image = await loadImage(Buffer.from(bytes));
  } catch {
    return dataUrl;
  }
  const naturalWidth = image.width;
  const naturalHeight = image.height;
  if (!naturalWidth || !naturalHeight) return dataUrl;

  const scale = Math.min(1, MAX_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const px = imageData.data;
  const pixel = (x: number, y: number) => (y * width + x) * 4;

  // A transparent border needs no keying; only an opaque flat box does.
  const corners = [
    pixel(0, 0),
    pixel(width - 1, 0),
    pixel(0, height - 1),
    pixel(width - 1, height - 1),
  ];
  const transparentBorder = corners.every((index) => (px[index + 3] ?? 0) <= EMPTY_ALPHA);

  if (!transparentBorder) {
    // Sample the border. Only a uniform border is treated as a removable
    // background, so a mark that bleeds to the edge is left intact.
    const sample: [number, number, number][] = [];
    const step = Math.max(1, Math.floor(Math.max(width, height) / 32));
    for (let x = 0; x < width; x += step) {
      for (const y of [0, height - 1]) {
        const i = pixel(x, y);
        sample.push([px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0]);
      }
    }
    for (let y = 0; y < height; y += step) {
      for (const x of [0, width - 1]) {
        const i = pixel(x, y);
        sample.push([px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0]);
      }
    }
    const sum = sample.reduce((acc, [r, g, b]) => [acc[0] + r, acc[1] + g, acc[2] + b], [
      0, 0, 0,
    ] as [number, number, number]);
    const background: [number, number, number] = [
      Math.round(sum[0] / sample.length),
      Math.round(sum[1] / sample.length),
      Math.round(sum[2] / sample.length),
    ];
    const uniform = sample.every(
      ([r, g, b]) =>
        Math.abs(r - background[0]) <= TOLERANCE &&
        Math.abs(g - background[1]) <= TOLERANCE &&
        Math.abs(b - background[2]) <= TOLERANCE,
    );
    if (uniform) {
      const matches = (i: number) => {
        if ((px[i + 3] ?? 0) <= EMPTY_ALPHA) return true;
        return (
          Math.abs((px[i] ?? 0) - background[0]) <= TOLERANCE &&
          Math.abs((px[i + 1] ?? 0) - background[1]) <= TOLERANCE &&
          Math.abs((px[i + 2] ?? 0) - background[2]) <= TOLERANCE
        );
      };
      // Flood-fill inward from every border pixel, so only the background
      // connected to the edge is cleared, never a white area inside the mark.
      const visited = new Uint8Array(width * height);
      const stack: number[] = [];
      const push = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const flat = y * width + x;
        if (visited[flat]) return;
        visited[flat] = 1;
        if (!matches(flat * 4)) return;
        px[flat * 4 + 3] = 0;
        stack.push(flat);
      };
      for (let x = 0; x < width; x += 1) {
        push(x, 0);
        push(x, height - 1);
      }
      for (let y = 0; y < height; y += 1) {
        push(0, y);
        push(width - 1, y);
      }
      while (stack.length > 0) {
        const flat = stack.pop()!;
        const x = flat % width;
        const y = (flat - x) / width;
        push(x - 1, y);
        push(x + 1, y);
        push(x, y - 1);
        push(x, y + 1);
      }
      context.putImageData(imageData, 0, 0);
    }
  }

  // Crop to the opaque bounding box so the mark fills its box, not its padding.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((px[pixel(x, y) + 3] ?? 0) <= EMPTY_ALPHA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return dataUrl;

  const pad = 2;
  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(width, maxX + pad + 1) - cropX;
  const cropH = Math.min(height, maxY + pad + 1) - cropY;
  const out = createCanvas(cropW, cropH);
  out.getContext("2d").drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  return out.toDataURL("image/png");
}
