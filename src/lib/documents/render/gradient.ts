/**
 * Aionos gradient assets, drawn in code so no artwork file is needed. The
 * brand guide's cover gradient (deep navy to electric blue with a soft cyan
 * glow bottom-left and a clay glow bottom-right) and the orb (the "i" dot:
 * cyan through electric blue and navy to a warm clay edge) are rendered as
 * PNGs with @napi-rs/canvas and embedded into the deck.
 *
 * Server-only: pptxgenjs and the PDF writer already depend on this canvas.
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

const DEEP_NAVY = "#030C44";
const AIONOS_NAVY = "#1C2453";
const ELECTRIC_BLUE = "#2148FB";
const ELECTRIC_CYAN = "#00ECFF";
const WARM_CLAY = "#FFAF75";

function glow(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
): void {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Deep navy to electric blue with the two approved corner glows. */
export function coverBackgroundDataUrl(width = 1920, height = 1080): string {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const base = ctx.createLinearGradient(0, 0, width * 0.4, height);
  base.addColorStop(0, DEEP_NAVY);
  base.addColorStop(1, ELECTRIC_BLUE);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  glow(ctx, width * 0.16, height * 1.02, width * 0.62, "rgba(0,236,255,0.55)");
  glow(ctx, width * 0.92, height * 1.08, width * 0.5, "rgba(255,175,117,0.42)");

  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}

/** The orb: cyan core through electric blue and navy to a warm clay edge. */
export function orbDataUrl(size = 640): string {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.46;
  const gradient = ctx.createRadialGradient(
    cx - size * 0.16,
    cy - size * 0.18,
    size * 0.02,
    cx,
    cy,
    radius,
  );
  gradient.addColorStop(0, ELECTRIC_CYAN);
  gradient.addColorStop(0.4, ELECTRIC_BLUE);
  gradient.addColorStop(0.62, AIONOS_NAVY);
  gradient.addColorStop(0.88, WARM_CLAY);
  gradient.addColorStop(1, "rgba(255,175,117,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
}
