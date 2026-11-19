/**
 * Client-side rasteriser: turns the server's raw logo data URL into a fixed
 * 512×144 PNG and measures it. Client-only — it touches `Image`, `document` and
 * `canvas`, so the server never needs a native canvas for logos.
 */
export type RasterLogo = { dataUrl: string; light: boolean; aspect: number };

/** Draw any supported image (SVG/PNG/JPEG/WebP) to a 512×144 PNG; compute light + aspect. */
export async function rasteriseLogo(dataUrl: string | undefined): Promise<RasterLogo | undefined> {
  if (!dataUrl || !/^data:image\/(?:svg\+xml|png|jpe?g|gif|webp|x-icon)/i.test(dataUrl)) {
    return undefined;
  }
  try {
    const image = new Image();
    image.decoding = "sync";
    const loaded = await new Promise<HTMLImageElement | null>((resolve) => {
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = dataUrl;
    });
    if (!loaded) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 144;
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    const scale = Math.min(
      canvas.width / (loaded.naturalWidth || canvas.width),
      canvas.height / (loaded.naturalHeight || canvas.height),
    );
    const width = (loaded.naturalWidth || canvas.width) * scale;
    const height = (loaded.naturalHeight || canvas.height) * scale;
    const x = (canvas.width - width) / 2;
    const y = (canvas.height - height) / 2;
    context.drawImage(loaded, x, y, width, height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let brightness = 0;
    let visible = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if ((pixels[index + 3] ?? 0) < 32) continue;
      brightness +=
        (pixels[index] ?? 0) * 0.2126 +
        (pixels[index + 1] ?? 0) * 0.7152 +
        (pixels[index + 2] ?? 0) * 0.0722;
      visible += 1;
    }
    // The mark is placed without any backing, so the PNG stays transparent.
    const light = visible > 0 && brightness / visible > 190;
    const png = canvas.toDataURL("image/png");
    const aspect = loaded.naturalHeight ? loaded.naturalWidth / loaded.naturalHeight : 3;
    return /^data:image\/png/.test(png) ? { dataUrl: png, light, aspect } : undefined;
  } catch {
    return undefined;
  }
}
