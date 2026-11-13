/**
 * Chart rasteriser for DOCX and PDF. PPTX uses native editable charts; these
 * formats get the same data and labelling as a PNG so the client sees a real
 * visual rather than a table. Colours come from the document theme.
 */
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { ChartSpec } from "./types";
import { DOCUMENT_THEME as THEME } from "./theme";

const WIDTH = 1200;
const HEIGHT = 675;
const SERIES_COLORS = [THEME.colors.accent, "#C97B2E", "#4C8C6A", "#8B6BAE", "#B5504B", "#6B7A8F"];

function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}bn`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return value.toLocaleString("en-GB", { maximumFractionDigits: 1 });
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  const step = value / base <= 1 ? 1 : value / base <= 2 ? 2 : value / base <= 5 ? 5 : 10;
  return step * base;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Returns PNG bytes, or null when the chart has no drawable data. */
export function chartPng(spec: ChartSpec): Uint8Array | null {
  const values = spec.series.flatMap((series) => series.values);
  if (values.length === 0 || spec.categories.length === 0) return null;
  if (spec.type === "pie" || spec.type === "doughnut") {
    return piePng(spec);
  }

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const left = 105;
  const right = WIDTH - 55;
  const top = 110;
  const bottom = HEIGHT - 95;
  const plotWidth = right - left;
  const plotHeight = bottom - top;

  ctx.fillStyle = THEME.colors.ink;
  ctx.font = "600 30px sans-serif";
  ctx.fillText(clip(spec.title, 62), left, 55);
  if (spec.unit) {
    ctx.fillStyle = THEME.colors.muted;
    ctx.font = "20px sans-serif";
    ctx.fillText(`Unit: ${spec.unit}`, left, 84);
  }

  const stacked = spec.type === "stacked_bar";
  const max = stacked
    ? Math.max(
        ...spec.categories.map((_, index) =>
          spec.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
        ),
      )
    : Math.max(...values);
  const ceiling = niceMax(max);

  // Grid and y labels.
  ctx.strokeStyle = THEME.colors.border;
  ctx.lineWidth = 1;
  ctx.fillStyle = THEME.colors.muted;
  ctx.font = "17px sans-serif";
  for (let line = 0; line <= 4; line += 1) {
    const y = bottom - (plotHeight * line) / 4;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.fillText(compact((ceiling * line) / 4), 16, y + 6);
  }

  const categoryWidth = plotWidth / spec.categories.length;
  const labelStep = Math.max(1, Math.ceil(spec.categories.length / 8));
  ctx.textAlign = "center";
  spec.categories.forEach((category, index) => {
    if (index % labelStep !== 0) return;
    ctx.fillStyle = THEME.colors.muted;
    ctx.font = "16px sans-serif";
    ctx.fillText(clip(category, 14), left + categoryWidth * (index + 0.5), bottom + 28);
  });
  ctx.textAlign = "left";

  if (spec.type === "line") {
    spec.series.forEach((series, seriesIndex) => {
      ctx.strokeStyle = SERIES_COLORS[seriesIndex % SERIES_COLORS.length] ?? THEME.colors.accent;
      ctx.lineWidth = 4;
      ctx.beginPath();
      series.values.forEach((value, index) => {
        const x = left + categoryWidth * (index + 0.5);
        const y = bottom - (value / ceiling) * plotHeight;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      series.values.forEach((value, index) => {
        const x = left + categoryWidth * (index + 0.5);
        const y = bottom - (value / ceiling) * plotHeight;
        ctx.fillStyle = SERIES_COLORS[seriesIndex % SERIES_COLORS.length] ?? THEME.colors.accent;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  } else if (stacked) {
    spec.categories.forEach((_, index) => {
      let cursor = bottom;
      const barWidth = Math.min(72, categoryWidth * 0.55);
      spec.series.forEach((series, seriesIndex) => {
        const value = series.values[index] ?? 0;
        const height = (value / ceiling) * plotHeight;
        cursor -= height;
        ctx.fillStyle = SERIES_COLORS[seriesIndex % SERIES_COLORS.length] ?? THEME.colors.accent;
        ctx.fillRect(left + categoryWidth * (index + 0.5) - barWidth / 2, cursor, barWidth, height);
      });
    });
  } else {
    const groupWidth = categoryWidth * 0.7;
    const barWidth = Math.max(8, groupWidth / spec.series.length - 8);
    spec.series.forEach((series, seriesIndex) => {
      ctx.fillStyle = SERIES_COLORS[seriesIndex % SERIES_COLORS.length] ?? THEME.colors.accent;
      series.values.forEach((value, index) => {
        const height = (value / ceiling) * plotHeight;
        const x =
          left + categoryWidth * (index + 0.5) - groupWidth / 2 + seriesIndex * (barWidth + 8);
        ctx.fillRect(x, bottom - height, barWidth, height);
      });
    });
  }

  // Legend.
  if (spec.series.length > 1) {
    let x = left;
    spec.series.forEach((series, index) => {
      ctx.fillStyle = SERIES_COLORS[index % SERIES_COLORS.length] ?? THEME.colors.accent;
      ctx.fillRect(x, HEIGHT - 42, 14, 14);
      ctx.fillStyle = THEME.colors.ink;
      ctx.font = "17px sans-serif";
      ctx.fillText(clip(series.name, 24), x + 22, HEIGHT - 30);
      x += 240;
    });
  }

  if (spec.basis === "assumption") badge(ctx);
  return canvas.toBuffer("image/png");
}

function piePng(spec: ChartSpec): Uint8Array | null {
  const series = spec.series[0];
  if (!series) return null;
  const total = series.values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return null;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = THEME.colors.ink;
  ctx.font = "600 30px sans-serif";
  ctx.fillText(clip(spec.title, 62), 55, 55);

  const cx = 330;
  const cy = 365;
  const radius = 210;
  const inner = spec.type === "doughnut" ? radius * 0.52 : 0;
  let angle = -Math.PI / 2;
  series.values.forEach((value, index) => {
    const slice = (Math.max(0, value) / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = SERIES_COLORS[index % SERIES_COLORS.length] ?? THEME.colors.accent;
    ctx.fill();
    angle += slice;
  });
  if (inner > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
  }

  ctx.font = "19px sans-serif";
  let y = 205;
  spec.categories.forEach((category, index) => {
    ctx.fillStyle = SERIES_COLORS[index % SERIES_COLORS.length] ?? THEME.colors.accent;
    ctx.fillRect(650, y - 14, 16, 16);
    ctx.fillStyle = THEME.colors.ink;
    ctx.fillText(clip(category, 30), 676, y);
    ctx.fillStyle = THEME.colors.muted;
    ctx.fillText(compact(series.values[index] ?? 0), 940, y);
    y += 42;
  });

  if (spec.basis === "assumption") badge(ctx);
  return canvas.toBuffer("image/png");
}

function badge(ctx: SKRSContext2D): void {
  ctx.fillStyle = THEME.colors.accentSoft;
  ctx.fillRect(WIDTH - 230, 24, 190, 34);
  ctx.fillStyle = THEME.colors.accentDark;
  ctx.font = "600 17px sans-serif";
  ctx.fillText("ILLUSTRATIVE", WIDTH - 214, 47);
}
