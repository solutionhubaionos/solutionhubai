import { publicUrl } from "./public-url";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_FILE = 400_000;

export type DownloadedLogo = { dataUrl: string; fallback?: string };

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

async function load(rawUrl: string, accept: string, timeout = 6_000) {
  const url = publicUrl(rawUrl);
  if (!url) return null;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { Accept: accept, "User-Agent": BROWSER_UA, "Accept-Language": "en-GB,en;q=0.9" },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_FILE) return null;
    return { bytes, fallback: response.headers.get("x-logo-fallback")?.toLowerCase() };
  } catch {
    return null;
  }
}

/** The logo as a data URL, in a format the browser can rasterise. */
export async function downloadLogo(url: string): Promise<DownloadedLogo | undefined> {
  const loaded = await load(url, "image/png,image/jpeg,image/*;q=0.8", 1_800);
  if (!loaded) return undefined;
  const bytes = loaded.bytes;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const gif = new TextDecoder().decode(bytes.subarray(0, 3)) === "GIF";
  const webp =
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  const ico = bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0;
  const head = new TextDecoder().decode(bytes.subarray(0, 400)).toLowerCase();
  const svg = head.includes("<svg") || (head.includes("<?xml") && head.includes("svg"));
  if (ico) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint16(4, true);
    const frames: { area: number; bytes: Uint8Array }[] = [];
    for (let index = 0; index < Math.min(count, 32); index += 1) {
      const entry = 6 + index * 16;
      if (entry + 16 > bytes.length) continue;
      const size = view.getUint32(entry + 8, true);
      const offset = view.getUint32(entry + 12, true);
      if (
        !size ||
        offset + size > bytes.length ||
        bytes[offset] !== 0x89 ||
        bytes[offset + 1] !== 0x50
      ) {
        continue;
      }
      const width = bytes[entry] || 256;
      const height = bytes[entry + 1] || 256;
      frames.push({ area: width * height, bytes: bytes.slice(offset, offset + size) });
    }
    frames.sort((a, b) => b.area - a.area);
    const frame = frames[0];
    if (frame) {
      return {
        dataUrl: `data:image/png;base64,${base64(frame.bytes)}`,
        ...(loaded.fallback ? { fallback: loaded.fallback } : {}),
      };
    }
  }
  if (!png && !jpeg && !gif && !webp && !ico && !svg) return undefined;
  const type = png
    ? "png"
    : jpeg
      ? "jpeg"
      : gif
        ? "gif"
        : webp
          ? "webp"
          : ico
            ? "x-icon"
            : "svg+xml";
  return {
    dataUrl: `data:image/${type};base64,${base64(bytes)}`,
    ...(loaded.fallback ? { fallback: loaded.fallback } : {}),
  };
}
