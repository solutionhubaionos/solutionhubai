/**
 * Renderer for the planner/writer DeckSpec. Native, editable PowerPoint shapes,
 * tables and charts; no auto-paging and no "(continued)" slides. A slide that
 * cannot fit its content is a build-stage defect, so the renderer refuses a deck
 * whose visible digits are not covered by the claims the slide cites.
 */
import PptxGenJS from "pptxgenjs";
import type { DeckChart, DeckSlideContent, DeckSpec, DeckSpecSlide } from "../deck/types";
import { DECK_THEME as T, resolveDeckConfig, type DeckConfig } from "../deck-theme";
import {
  AIONOS_TOKENS,
  CHART_SERIES_LIGHT,
  CHART_SERIES_NAVY,
  SURFACE_BACKGROUND,
  type Surface,
} from "../brand-guide";
import { palette } from "../tokens";
import { AIONOS_LOGO } from "../assets/aionos-logo";
import { DECK_THEME_IMAGES } from "../assets/aionos-theme";
import { claimValue, untracedNumbers } from "../deck/claims";
import { hasPlaceholders } from "../deck/text-guards";
import { tidyPie, validateChart } from "../deck/chart-validate";
import { visibleStrings } from "../deck/writer";
import { contrastRatio } from "../../brand/color";
import { normalizeDeckPackage } from "./pptx-package";

const IMG = DECK_THEME_IMAGES;

/** Cover facts gathered by the build stage and rendered onto the cover pages. */
export type DeckCoverMeta = {
  date: string;
  subtitle: string;
  /** The target sector/industry, used as the eyebrow on content slides. */
  industry?: string | null;
  /** The pitched client, used for the co-brand lockup. */
  customer?: string | null;
};

/**
 * The brand theme, read once from `aionos.tokens.json` (via DECK_THEME). C, FONTS
 * and SERIES are the colours, typefaces and chart marks; the per-slide `VIEW`
 * below holds the box/border rules for whichever surface the current slide uses.
 *
 * shortcut: `VIEW` is module-level and set per slide, so two exports rendering
 * concurrently could interleave surfaces. Upgrade to a surface passed through
 * every helper if concurrent rendering ever matters.
 */
const C: Record<keyof typeof T.colors, string> = { ...T.colors };
const FONTS: { heading: string; body: string; chart: string } = { ...T.fonts };
const SERIES: string[] = [...T.chartSeries];

const WHITE_HEX = AIONOS_TOKENS.white;
const NAVY_HEX = AIONOS_TOKENS.aionos_navy;
const DEEP_HEX = AIONOS_TOKENS.deep_navy;
const BLUE_HEX = AIONOS_TOKENS.electric_blue;
const SOFT_HEX = AIONOS_TOKENS.soft_blue;
const PEARL_HEX = AIONOS_TOKENS.pearl;

type SurfaceView = {
  background: string;
  /** Body and heading ink for text placed straight on the page background. */
  ink: string;
  inkMuted: string;
  label: string;
  heading: string;
  /** Fills for extra boxes/cards/borders, plus the ink for text inside them. */
  card: string;
  cardBorder: string;
  cardInk: string;
  cardMuted: string;
  /** Table banding, and the ink that sits on those bands. */
  rowEven: string;
  rowOdd: string;
  rowInk: string;
  /** Accent marks (chips, dots, tags) and the ink for text inside them. */
  accent: string;
  onAccent: string;
  /** The Aionos wordmark variant that reads on this surface. */
  logo: string;
  series: string[];
  /** True for the gradient page: draw the baked image behind the content. */
  gradient: boolean;
};

/**
 * The kit's box/border rules per surface. On a WHITE page a box is electric blue
 * with white text; on a BLUE (navy) or deep-navy page a box is white/pearl with
 * deep navy text. Tables band white/pearl with deep navy text on every surface.
 */
function surfaceView(surface: Surface): SurfaceView {
  const background = palette[SURFACE_BACKGROUND[surface]];
  if (surface === "light") {
    return {
      background,
      ink: DEEP_HEX,
      inkMuted: NAVY_HEX,
      label: BLUE_HEX,
      heading: DEEP_HEX,
      card: BLUE_HEX,
      cardBorder: BLUE_HEX,
      cardInk: WHITE_HEX,
      cardMuted: WHITE_HEX,
      rowEven: WHITE_HEX,
      rowOdd: PEARL_HEX,
      rowInk: DEEP_HEX,
      accent: BLUE_HEX,
      onAccent: WHITE_HEX,
      logo: AIONOS_LOGO.navy,
      series: CHART_SERIES_LIGHT,
      gradient: false,
    };
  }
  // The dark ground: solid deep navy for section dividers and the closing; the
  // cover bleeds the baked guideline gradient on the same navy fallback.
  return {
    background,
    ink: WHITE_HEX,
    inkMuted: SOFT_HEX,
    label: SOFT_HEX,
    heading: WHITE_HEX,
    card: PEARL_HEX,
    cardBorder: PEARL_HEX,
    cardInk: DEEP_HEX,
    cardMuted: NAVY_HEX,
    rowEven: WHITE_HEX,
    rowOdd: PEARL_HEX,
    rowInk: DEEP_HEX,
    accent: WHITE_HEX,
    onAccent: DEEP_HEX,
    logo: AIONOS_LOGO.white,
    series: CHART_SERIES_NAVY,
    gradient: surface === "gradient",
  };
}

let VIEW: SurfaceView = surfaceView("light");
/** The target industry shown as the eyebrow on every content page. */
let EYEBROW = "";
/** The footer wordmark ("Aionos") drawn bottom-left on every content page. */
let FOOTER = "Aionos";
/** The "01" prefix carried by the current slide's heading. */
let SLIDE_NUMBER = "";

/** Selects the surface for the next slide (kit rhythm; set once per slide). */
function setSurface(surface: Surface): void {
  VIEW = surfaceView(surface);
}

/** Headings follow the surface ink; hierarchy is size and weight. */
function headingColor(_index = 0): string {
  return VIEW.heading;
}

/** A preferred ink, unless it would be unreadable on this slide's canvas. */
function readableInk(background: string, preferred: string): string {
  return contrastRatio(preferred, background) >= 4.5 ? preferred : WHITE_HEX;
}

function cardInk(): string {
  return VIEW.cardInk;
}

function cardMuted(): string {
  return VIEW.cardMuted;
}

function cardHeading(_index = 0): string {
  return VIEW.cardInk;
}

function pageBackground(): string {
  return VIEW.background;
}

const G = T.geometry;
const S = T.type;
const W = G.width;
const H = G.height;
const M = G.margin;
const CONTENT_W = W - M * 2;

type Slide = ReturnType<PptxGenJS["addSlide"]>;

/* ------------------------------------------------------------------ text --- */

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** "01", "02", ... the number every slide heading carries in the kit. */
function sectionNumber(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function short(text: string, max: number): string {
  const value = clean(text);
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > max * 0.6 ? space : max).trimEnd()}…`;
}

/** Splits prose into slide-sized chunks, breaking on a word where possible. */
function splitSlideText(text: string, maxChars = 490): string[] {
  const chunks: string[] = [];
  let rest = clean(text);
  while (rest) {
    let end = Math.min(rest.length, maxChars);
    if (end < rest.length) {
      const space = rest.lastIndexOf(" ", end);
      if (space > end / 2) end = space;
    }
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).trim();
  }
  return chunks;
}

function addText(
  slide: Slide,
  value: string,
  x: number,
  y: number,
  w: number,
  h: number,
  options: Partial<PptxGenJS.TextPropsOptions> = {},
): void {
  slide.addText(clean(value), {
    x,
    y,
    w,
    h,
    fontFace: FONTS.body,
    fontSize: S.body,
    color: VIEW.ink,
    margin: 0,
    valign: "top",
    isTextBox: true,
    ...options,
  });
}

function addRichTitle(slide: Slide, value: string): void {
  const clean_ = clean(value);
  const text = SLIDE_NUMBER ? `${SLIDE_NUMBER}  ${clean_}` : clean_;
  slide.addText(text, {
    x: M,
    y: G.titleY,
    w: CONTENT_W,
    h: G.titleH,
    fontFace: FONTS.heading,
    fontSize: text.length > 100 ? 27 : 34,
    bold: true,
    color: headingColor(0),
    margin: 0,
    valign: "top",
    isTextBox: true,
    fit: "shrink",
  });
}

type ChromeOptions = {
  /** The eyebrow: the target industry when the deck knows one, else a layout tag. */
  tag?: string;
  dark?: boolean;
  index: number;
};

/**
 * Every page is drawn directly: the reference kit has no alternating surface,
 * so a slide master would only carry one background and one footer colour. The
 * eyebrow and the wordmark sit top-left and top-right; the page number sits
 * bottom-right.
 */
function chrome(pres: PptxGenJS, options: ChromeOptions): Slide {
  const slide = pres.addSlide();
  slide.background = { color: VIEW.background };
  if (VIEW.gradient) slide.addImage({ data: IMG.gradient, x: 0, y: 0, w: W, h: H });
  slide.addImage({
    data: VIEW.logo,
    x: W - M - 1.7,
    y: 0.33,
    w: 1.7,
    h: 0.44,
    sizing: { type: "contain", w: 1.7, h: 0.44 },
  });
  const eyebrow = EYEBROW || options.tag || "";
  if (eyebrow) {
    addText(slide, eyebrow, M, 0.42, 8.8, 0.28, {
      fontFace: FONTS.body,
      fontSize: 11,
      color: VIEW.label,
      charSpacing: 1.3,
    });
  }
  addText(slide, String(options.index), W - M - 0.6, 6.94, 0.6, 0.2, {
    fontSize: 11,
    color: VIEW.inkMuted,
    align: "right",
  });
  addText(slide, FOOTER, M, 6.94, 4, 0.2, {
    fontSize: 11,
    color: VIEW.inkMuted,
    charSpacing: 1.1,
  });
  return slide;
}

function tierBadge(slide: Slide, tier: DeckSpecSlide["tier"]): void {
  if (tier === "sourced") return;
  const label = tier === "illustrative" ? "ILLUSTRATIVE" : "PROPOSED";
  const color = tier === "illustrative" ? C.amber : C.coral;
  slide.addShape("roundRect", {
    x: M,
    y: H - 0.62,
    w: 1.5,
    h: 0.28,
    fill: { color: AIONOS_TOKENS.pearl },
    line: { color, width: 0.75 },
    rectRadius: 0.08,
  });
  addText(slide, label, M, H - 0.59, 1.5, 0.24, {
    fontSize: 11,
    bold: true,
    color: C.navy,
    align: "center",
  });
}

function sourceLine(slide: Slide, value: string): void {
  if (!value) return;
  addText(slide, short(value, 120), M, G.sourceY, CONTENT_W, 0.22, {
    fontSize: S.caption,
    color: VIEW.inkMuted,
    italic: true,
  });
}

/* ---------------------------------------------------------------- slides --- */

/** The guideline cover: the baked deep-navy → electric-blue gradient, the Aionos
 * wordmark, the deck title and the client's logo in its reserved box. */
function cover(
  pres: PptxGenJS,
  spec: DeckSpec,
  meta: DeckCoverMeta,
  pageNumber: number,
  clientLogo: { dataUrl: string; light: boolean; aspect: number } | null,
): void {
  const slide = pres.addSlide();
  slide.background = { color: DEEP_HEX };
  slide.addImage({ data: IMG.gradient, x: 0, y: 0, w: W, h: H });
  // The Aionos wordmark, top-left, from the template. Never redrawn.
  slide.addImage({
    data: IMG.whiteLogo,
    x: M,
    y: 0.5,
    w: 1.9,
    h: 0.5,
    sizing: { type: "contain", w: 1.9, h: 0.5 },
  });
  placeClientLogo(slide, clientLogo);
  const title = clean(spec.deckTitle);
  slide.addText(title, {
    x: M,
    y: 2.15,
    w: 8.0,
    h: 1.9,
    fontFace: FONTS.heading,
    fontSize: title.length > 90 ? 34 : 40,
    bold: true,
    color: C.white,
    margin: 0,
    valign: "bottom",
    isTextBox: true,
    fit: "shrink",
  });
  const summary = splitSlideText(spec.storyline, 280);
  slide.addText(summary[0] ?? "", {
    x: M,
    y: 4.2,
    w: 7.4,
    h: 1.5,
    fontFace: FONTS.body,
    fontSize: 16,
    color: C.white,
    margin: 0,
    valign: "top",
    isTextBox: true,
    fit: "shrink",
  });
  const subtitle = clean([meta.subtitle, spec.audience].filter(Boolean).join("  ·  "));
  if (subtitle) {
    slide.addText(subtitle, {
      x: M,
      y: 5.75,
      w: 7.4,
      h: 0.5,
      fontFace: FONTS.body,
      fontSize: 13,
      color: SOFT_HEX,
      margin: 0,
      valign: "top",
      isTextBox: true,
      fit: "shrink",
    });
  }
  slide.addText(clean([meta.date, FOOTER].filter(Boolean).join("  ·  ")), {
    x: M,
    y: 6.94,
    w: 8,
    h: 0.2,
    fontFace: FONTS.body,
    fontSize: 11,
    color: C.white,
    margin: 0,
    isTextBox: true,
  });
  slide.addText(String(pageNumber), {
    x: W - M - 0.6,
    y: 6.94,
    w: 0.6,
    h: 0.2,
    fontFace: FONTS.body,
    fontSize: 11,
    color: C.white,
    margin: 0,
    align: "right",
    isTextBox: true,
  });
  slide.addNotes(clean(spec.storyline));
}

/** The closing page, on the solid deep-navy ground the guideline uses. */
function closingSlide(pres: PptxGenJS, spec: DeckSpec, meta: DeckCoverMeta, index: number): void {
  setSurface("navy");
  const slide = chrome(pres, { index });
  slide.addText("Thank you", {
    x: M,
    y: 2.7,
    w: CONTENT_W,
    h: 1.2,
    fontFace: FONTS.heading,
    fontSize: 44,
    bold: true,
    color: VIEW.heading,
    margin: 0,
    valign: "middle",
    isTextBox: true,
    fit: "shrink",
  });
  const contact = clean([meta.subtitle, spec.audience].filter(Boolean).join("  ·  "));
  if (contact) {
    addText(slide, contact, M, 4.15, CONTENT_W, 0.5, {
      fontSize: 15,
      color: VIEW.inkMuted,
    });
  }
  slide.addNotes("Close by confirming the next step and the owner.");
}

/**
 * The client's mark in the cover's reserved box, scaled to fit with the aspect
 * ratio preserved and clear space either side. A dark or transparent logo that
 * would fail contrast on the gradient sits on a white rounded card. No logo,
 * no card, no placeholder text; the export never fails for a missing mark.
 */
function placeClientLogo(
  slide: Slide,
  clientLogo: { dataUrl: string; light: boolean; aspect: number } | null,
): void {
  if (!clientLogo) return;
  const boxW = 3.4;
  const boxH = 1.5;
  const x = W - M - boxW;
  const y = 0.4;
  if (!clientLogo.light) {
    slide.addShape("roundRect", {
      x,
      y,
      w: boxW,
      h: boxH,
      fill: { color: WHITE_HEX },
      line: { color: WHITE_HEX, width: 0 },
      rectRadius: 0.1,
    });
  }
  const pad = clientLogo.light ? 0 : 0.28;
  const w = boxW - pad * 2;
  const h = boxH - pad * 2;
  slide.addImage({
    data: clientLogo.dataUrl,
    x: x + pad,
    y: y + pad,
    w,
    h,
    sizing: { type: "contain", w, h },
  });
}

function divider(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { index });
  if (slideSpec.content.layout !== "section-divider") return;
  addText(slide, SLIDE_NUMBER, M, 1.5, 2, 0.5, {
    fontFace: FONTS.heading,
    fontSize: 15,
    bold: true,
    color: VIEW.ink,
    charSpacing: 2,
  });
  slide.addText(clean(slideSpec.content.label), {
    x: M,
    y: 2.1,
    w: CONTENT_W - 0.8,
    h: 1.8,
    fontFace: FONTS.heading,
    fontSize: 36,
    bold: true,
    color: readableInk(pageBackground(), headingColor(0)),
    margin: 0,
    valign: "middle",
    isTextBox: true,
    fit: "shrink",
  });
  if (slideSpec.content.statement) {
    addText(slide, slideSpec.content.statement, M, 4.05, CONTENT_W - 1.2, 1.0, {
      fontSize: 16,
      color: VIEW.ink,
    });
  }
  slide.addNotes(slideSpec.notes);
}

function bulletsSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { tag: "Context", index });
  addRichTitle(slide, slideSpec.actionTitle);
  if (slideSpec.content.layout !== "context-bullets") return;
  tierBadge(slide, slideSpec.tier);
  const bullets = slideSpec.content.bullets.slice(0, 4);
  const top = 2.05;
  const gap = 0.14;
  const rowH = Math.min(
    1.0,
    (5.9 - top - gap * (bullets.length - 1)) / Math.max(bullets.length, 1),
  );
  bullets.forEach((bullet, position) => {
    const y = top + position * (rowH + gap);
    slide.addShape("roundRect", {
      x: M,
      y,
      w: CONTENT_W,
      h: rowH,
      fill: { color: VIEW.card },
      line: { color: VIEW.cardBorder, width: 0.5 },
      rectRadius: 0.08,
    });
    slide.addShape("rect", {
      x: M,
      y,
      w: 0.07,
      h: rowH,
      fill: { color: VIEW.accent },
      line: { color: VIEW.accent, width: 0 },
    });
    addText(slide, bullet.text, M + 0.32, y + 0.1, CONTENT_W - 0.6, rowH - 0.18, {
      fontSize: 16,
      color: cardInk(),
      valign: "middle",
      fit: "shrink",
    });
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

function kpiSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, spec: DeckSpec, index: number): void {
  const slide = chrome(pres, { tag: "Evidence", index });
  addRichTitle(slide, slideSpec.actionTitle);
  if (slideSpec.content.layout !== "kpi-cards") return;
  tierBadge(slide, slideSpec.tier);
  const cards = slideSpec.content.cards.slice(0, 4);
  const gap = 0.22;
  const cardW = (CONTENT_W - gap * (cards.length - 1)) / Math.max(cards.length, 1);
  cards.forEach((card, position) => {
    const x = M + position * (cardW + gap);
    slide.addShape("roundRect", {
      x,
      y: 2.0,
      w: cardW,
      h: 3.45,
      fill: { color: VIEW.card },
      line: { color: VIEW.cardBorder, width: 0.75 },
      rectRadius: 0.1,
    });
    slide.addShape("rect", {
      x,
      y: 2.0,
      w: cardW,
      h: 0.08,
      fill: { color: VIEW.series[position % SERIES.length]! },
      line: { color: VIEW.cardBorder, width: 0 },
    });
    const claim = spec.claims[card.claimId];
    slide.addText(claim ? claimValue(claim) : "", {
      x: x + 0.16,
      y: 2.35,
      w: cardW - 0.32,
      h: 1.35,
      fontFace: FONTS.heading,
      fontSize: S.kpiValue,
      bold: true,
      color: cardHeading(0),
      margin: 0,
      valign: "middle",
      isTextBox: true,
      fit: "shrink",
    });
    addText(slide, card.label, x + 0.18, 3.9, cardW - 0.36, 0.7, {
      fontSize: S.kpiLabel,
      bold: true,
      color: cardHeading(1),
    });
    if (card.note) {
      addText(slide, card.note, x + 0.18, 4.55, cardW - 0.36, 0.42, {
        fontSize: 12,
        color: cardMuted(),
      });
    }
    const source = claim
      ? `${claim.sourceTitle}${claim.sourceYear ? `, ${claim.sourceYear}` : ""}`
      : "";
    addText(slide, short(source, 48), x + 0.18, 5.08, cardW - 0.36, 0.3, {
      fontSize: 9,
      color: cardMuted(),
      italic: true,
    });
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

function hubSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { tag: "Partners", index });
  addRichTitle(slide, slideSpec.actionTitle);
  if (slideSpec.content.layout !== "partner-hub") return;
  if (slideSpec.tier !== "sourced") tierBadge(slide, slideSpec.tier);
  const centreX = W / 2;
  const centreY = 4.3;
  const spokes = slideSpec.content.spokes.slice(0, 6);
  const angleStep = (Math.PI * 2) / Math.max(spokes.length, 1);
  const start = -Math.PI / 2;

  spokes.forEach((spoke, position) => {
    const angle = start + position * angleStep;
    const boxW = 3.05;
    const boxH = 1.02;
    const x = centreX + Math.cos(angle) * 3.75 - boxW / 2;
    const y = centreY + Math.sin(angle) * 2.15 - boxH / 2;
    const spokeX = x + boxW / 2;
    const spokeY = y + boxH / 2;
    const dx = spokeX - centreX;
    const dy = spokeY - centreY;
    slide.addShape("line", {
      x: Math.min(centreX, spokeX),
      y: Math.min(centreY, spokeY),
      w: Math.abs(dx),
      h: Math.abs(dy),
      // The connector is drawn on the bounding-box diagonal; a mixed-direction
      // spoke needs the vertical flip to land on the other diagonal.
      flipH: dx < 0 !== dy < 0,
      line: { color: VIEW.cardBorder, width: 1.25 },
    });
    slide.addShape("roundRect", {
      x,
      y,
      w: boxW,
      h: boxH,
      fill: { color: VIEW.card },
      line: { color: spoke.inferred ? C.amber : VIEW.cardBorder, width: 0.75 },
      rectRadius: 0.1,
    });
    addText(slide, spoke.entity, x + 0.14, y + 0.1, boxW - 0.28, 0.3, {
      fontSize: 13,
      bold: true,
      color: cardInk(),
    });
    addText(slide, spoke.role, x + 0.14, y + 0.4, boxW - 0.28, 0.56, {
      fontSize: 12,
      color: cardMuted(),
      valign: "top",
    });
  });

  slide.addShape("ellipse", {
    x: centreX - 1.55,
    y: centreY - 0.72,
    w: 3.1,
    h: 1.44,
    fill: { color: VIEW.card },
    line: { color: VIEW.accent, width: 1 },
  });
  addText(slide, slideSpec.content.centre, centreX - 1.32, centreY - 0.45, 2.64, 0.9, {
    fontSize: 14,
    bold: true,
    color: cardInk(),
    align: "center",
    valign: "middle",
    fontFace: FONTS.heading,
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

function compareSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { tag: "The change", index });
  addRichTitle(slide, slideSpec.actionTitle);
  const content = slideSpec.content;
  if (content.layout !== "two-column-compare" && content.layout !== "before-after") return;
  tierBadge(slide, slideSpec.tier);
  const gap = 0.3;
  const panelW = (CONTENT_W - gap) / 2;
  const sides = [
    { ...content.left, color: VIEW.accent, bg: VIEW.card },
    { ...content.right, color: VIEW.heading, bg: VIEW.card },
  ];
  sides.forEach((side, position) => {
    const x = M + position * (panelW + gap);
    slide.addShape("roundRect", {
      x,
      y: 2.0,
      w: panelW,
      h: 4.2,
      fill: { color: side.bg },
      line: { color: VIEW.cardBorder, width: 0.75 },
      rectRadius: 0.1,
    });
    addText(slide, side.heading, x + 0.22, 2.18, panelW - 0.44, 0.42, {
      fontSize: 16,
      bold: true,
      color: cardInk(),
      fontFace: FONTS.heading,
    });
    side.points.slice(0, 4).forEach((point, pointIndex) => {
      const y = 2.78 + pointIndex * 0.8;
      slide.addShape("ellipse", {
        x: x + 0.24,
        y: y + 0.08,
        w: 0.09,
        h: 0.09,
        fill: { color: side.color },
        line: { color: side.color, width: 0 },
      });
      addText(slide, point, x + 0.45, y, panelW - 0.68, 0.7, {
        fontSize: 13,
        color: cardInk(),
      });
    });
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

function tableSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, tag: string, index: number): void {
  const slide = chrome(pres, { tag, index });
  addRichTitle(slide, slideSpec.actionTitle);
  const content = slideSpec.content;
  if (
    content.layout !== "table-compact" &&
    content.layout !== "shortcomings-table" &&
    content.layout !== "collaboration-pointers-table"
  ) {
    return;
  }
  tierBadge(slide, slideSpec.tier);
  const headers = content.headers.slice(0, 3);
  const rows = content.rows
    .slice(0, 5)
    .map((row) => headers.map((_, cell) => short(row[cell] ?? "", 90)));
  const weights = headers.map((header, column) =>
    Math.max(
      7,
      header.length,
      ...rows.map((row) => (row[column] ?? "").length * (column === 0 ? 0.55 : 0.45)),
    ),
  );
  const total = weights.reduce((sum, value) => sum + value, 0);
  const colW = weights.map((value) => Number(((value / total) * CONTENT_W).toFixed(3)));
  const table: PptxGenJS.TableRow[] = [
    headers.map((header) => ({
      text: header,
      options: {
        bold: true,
        color: WHITE_HEX,
        fill: { color: C.blue },
        fontSize: S.tableHeader,
        fontFace: FONTS.heading,
        valign: "middle" as const,
      },
    })),
    ...rows.map((row, rowIndex) =>
      row.map((cell) => ({
        text: cell,
        options: {
          color: VIEW.rowInk,
          fill: { color: rowIndex % 2 === 0 ? VIEW.rowEven : VIEW.rowOdd },
          fontSize: S.table,
          fontFace: FONTS.body,
          valign: "middle" as const,
        },
      })),
    ),
  ];
  slide.addTable(table, {
    x: M,
    y: 2.05,
    w: CONTENT_W,
    colW,
    rowH: 0.55,
    border: { type: "solid", pt: 0.75, color: VIEW.cardBorder },
    autoPage: false,
    margin: 0.08,
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

function roadmapSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { tag: "Delivery", index });
  addRichTitle(slide, slideSpec.actionTitle);
  if (slideSpec.content.layout !== "process-roadmap") return;
  tierBadge(slide, slideSpec.tier);
  const steps = slideSpec.content.steps.slice(0, 5);
  const gap = 0.22;
  const cardW = (CONTENT_W - gap * (steps.length - 1)) / Math.max(steps.length, 1);
  steps.forEach((step, position) => {
    const x = M + position * (cardW + gap);
    slide.addShape("roundRect", {
      x,
      y: 2.15,
      w: cardW,
      h: 3.6,
      fill: { color: VIEW.card },
      line: { color: VIEW.cardBorder, width: 0.75 },
      rectRadius: 0.1,
    });
    slide.addShape("ellipse", {
      x: x + 0.18,
      y: 2.3,
      w: 0.44,
      h: 0.44,
      fill: { color: VIEW.card },
      line: { color: VIEW.accent, width: 0.75 },
    });
    addText(slide, String(position + 1), x + 0.18, 2.38, 0.44, 0.28, {
      fontSize: 13,
      bold: true,
      color: cardInk(),
      align: "center",
    });
    addText(slide, step.label, x + 0.18, 2.92, cardW - 0.36, 0.55, {
      fontSize: 16,
      bold: true,
      color: cardInk(),
      fontFace: FONTS.heading,
    });
    if (step.detail) {
      addText(slide, step.detail, x + 0.18, 3.55, cardW - 0.36, 1.9, {
        fontSize: 12,
        color: cardMuted(),
      });
    }
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

function chartSlide(
  pres: PptxGenJS,
  slideSpec: DeckSpecSlide,
  spec: DeckSpec,
  index: number,
): void {
  const slide = chrome(pres, { tag: "Evidence", index });
  addRichTitle(slide, slideSpec.actionTitle);
  if (slideSpec.content.layout !== "chart-with-takeaway") return;
  if (slideSpec.tier !== "sourced") tierBadge(slide, slideSpec.tier);
  const chart = slideSpec.content.chart;
  const resolved = chartData(chart, spec);
  if (resolved) {
    const kind = chart.kind === "doughnut" ? "doughnut" : chart.kind === "line" ? "line" : "bar";
    const data = resolved.series.map((series) => ({
      name: series.name,
      labels: resolved.categories,
      values: series.values,
    }));
    const pie = kind === "doughnut";
    const range = chart.kind === "range";
    const options: PptxGenJS.IChartOpts = {
      x: M + 0.1,
      y: 1.95,
      w: CONTENT_W - 0.2,
      h: 3.55,
      chartColors: [...VIEW.series],
      showTitle: true,
      title: chart.unit ? `${chart.title} (${chart.unit})` : chart.title,
      titleFontFace: FONTS.chart,
      titleFontSize: 13,
      titleColor: headingColor(0),
      titleAlign: "left",
      showLegend: resolved.series.length > 1 || pie,
      legendPos: "b",
      legendFontSize: 11,
      // A floating range is drawn as base + span, so the segment values must
      // not be printed as if they were the range itself.
      showValue: !pie && !range,
      showPercent: pie,
      dataLabelPosition: pie ? "outEnd" : kind === "line" ? "t" : "outEnd",
      dataLabelFontFace: FONTS.chart,
      dataLabelFontSize: 11,
      dataLabelColor: VIEW.ink,
      dataLabelFontBold: true,
      dataLabelFormatCode: "#,##0;-#,##0;;",
      catAxisLabelFontFace: FONTS.chart,
      catAxisLabelFontSize: 10,
      // Chart text takes the kit's highlights on the white plot; data labels
      // stay black because they sit on the coloured series fills.
      catAxisLabelColor: VIEW.ink,
      valAxisLabelFontFace: FONTS.chart,
      valAxisLabelFontSize: 10,
      valAxisLabelColor: VIEW.ink,
      valGridLine: { style: "solid", color: VIEW.cardBorder, size: 0.75 },
      catGridLine: { style: "none" },
      valAxisLineShow: false,
      catAxisLineColor: VIEW.cardBorder,
      barDir: "col",
      barGapWidthPct: 65,
      chartArea: { fill: { color: pageBackground() } },
      plotArea: { fill: { color: pageBackground() } },
      border: { pt: 0, color: pageBackground() },
      ...(kind === "line" ? { lineSize: 2.5, lineDataSymbol: "circle" } : {}),
      ...(pie ? { holeSize: 55 } : {}),
    };
    slide.addChart(kind, data, options);
  }
  slide.addShape("rect", {
    x: M,
    y: 5.72,
    w: 0.06,
    h: 0.62,
    fill: { color: VIEW.accent },
    line: { color: VIEW.accent, width: 0 },
  });
  addText(slide, slideSpec.content.takeaway, M + 0.2, 5.72, CONTENT_W - 0.3, 0.62, {
    fontSize: 14,
    color: VIEW.ink,
    fontFace: FONTS.heading,
    valign: "middle",
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

function chartData(
  chart: DeckChart,
  spec: DeckSpec,
): { categories: string[]; series: { name: string; values: number[] }[] } | null {
  const categories = chart.series[0]?.points.map((point) => point.label) ?? [];
  if (categories.length < 2) return null;
  if (chart.kind === "range") {
    const base: number[] = [];
    const span: number[] = [];
    for (const point of chart.series[0]?.points ?? []) {
      const claim = spec.claims[point.claimId];
      const min = claim?.valueMin ?? null;
      const max = claim?.valueMax ?? null;
      if (min === null || max === null) return null;
      base.push(min);
      span.push(Math.max(0, max - min));
    }
    return {
      categories,
      series: [
        { name: "Low", values: base },
        { name: "Range", values: span },
      ],
    };
  }
  const series = chart.series
    .map((entry) => ({
      name: entry.name,
      values: entry.points
        .map(
          (point) =>
            spec.claims[point.claimId]?.valueMax ?? spec.claims[point.claimId]?.valueMin ?? null,
        )
        .filter((value): value is number => value !== null),
    }))
    .filter((entry) => entry.values.length === categories.length);
  if (series.length === 0) return null;
  // A pie is drawn from one series and must sum to a readable whole.
  if (chart.kind === "doughnut") {
    const tidied = tidyPie(categories, series[0]!.values);
    const pie = {
      categories: tidied.categories,
      series: [{ name: series[0]!.name, values: tidied.values }],
    };
    return validateChart({ kind: "doughnut", ...pie }).ok ? pie : null;
  }
  const result = { categories, series };
  return validateChart({ kind: chart.kind, ...result }).ok ? result : null;
}

function imageSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { tag: "In focus", index });
  addRichTitle(slide, slideSpec.actionTitle);
  if (slideSpec.content.layout !== "image-with-caption") return;
  tierBadge(slide, slideSpec.tier);
  const photo = IMG.closingPhotos[index % IMG.closingPhotos.length];
  if (photo) {
    slide.addImage({
      data: photo,
      x: M,
      y: 2.0,
      w: CONTENT_W,
      h: 3.5,
      sizing: { type: "cover", w: CONTENT_W, h: 3.5 },
    });
    addText(slide, slideSpec.content.caption, M, 5.62, CONTENT_W, 0.8, {
      fontSize: 16,
      color: VIEW.ink,
      fontFace: FONTS.heading,
      align: "center",
      valign: "top",
      fit: "shrink",
    });
  } else {
    slide.addShape("roundRect", {
      x: M,
      y: 2.0,
      w: CONTENT_W,
      h: 3.7,
      fill: { color: VIEW.card },
      line: { color: VIEW.cardBorder, width: 0.75 },
      rectRadius: 0.1,
    });
    addText(slide, slideSpec.content.caption, M + 0.6, 2.75, CONTENT_W - 1.2, 2.2, {
      fontSize: 22,
      color: cardInk(),
      fontFace: FONTS.heading,
      align: "center",
      valign: "middle",
    });
  }
  sourceLine(slide, slideSpec.content.sourceNote || slideSpec.sourceNote || "");
  slide.addNotes(slideSpec.notes);
}

function askSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { index });
  if (slideSpec.content.layout !== "next-steps-ask") return;
  addText(slide, "THE ASK", M, 0.85, 4, 0.3, {
    fontSize: 12,
    bold: true,
    color: VIEW.ink,
    charSpacing: 2.4,
    fontFace: FONTS.heading,
  });
  slide.addText(clean(slideSpec.content.ask), {
    x: M,
    y: 1.35,
    w: CONTENT_W - 0.8,
    h: 1.45,
    fontFace: FONTS.heading,
    fontSize: 32,
    bold: true,
    color: VIEW.ink,
    margin: 0,
    valign: "middle",
    isTextBox: true,
    fit: "shrink",
  });
  const steps = slideSpec.content.steps.slice(0, 4);
  steps.forEach((step, position) => {
    const y = 3.35 + position * 0.78;
    slide.addShape("ellipse", {
      x: M,
      y: y + 0.02,
      w: 0.42,
      h: 0.42,
      fill: { color: VIEW.accent },
      line: { color: VIEW.accent, width: 0 },
    });
    addText(slide, String(position + 1), M, y + 0.09, 0.42, 0.28, {
      fontSize: 13,
      bold: true,
      color: VIEW.onAccent,
      align: "center",
    });
    addText(slide, step.text, M + 0.62, y, 8.2, 0.42, {
      fontSize: 15,
      color: VIEW.ink,
    });
    const meta = [step.owner, step.when].filter(Boolean).join(" · ");
    if (meta) {
      addText(slide, meta, M + 9.0, y, 3.1, 0.42, {
        fontSize: 12,
        color: VIEW.ink,
        align: "right",
      });
    }
  });
  slide.addNotes(slideSpec.notes);
}

/* --------------------------------------------------------- consulting visuals --- */

/**
 * Ordered capability stages. Deliberately qualitative: a maturity model shows
 * progression, never a made-up score per stage. Only the renderer's own stage
 * numerals appear, never a data value.
 */
function maturitySlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { tag: "Journey", index });
  addRichTitle(slide, slideSpec.actionTitle);
  if (slideSpec.content.layout !== "maturity-progression") return;
  if (slideSpec.tier !== "sourced") tierBadge(slide, slideSpec.tier);

  const stages = slideSpec.content.stages.slice(0, 5);
  const count = Math.max(stages.length, 1);
  const gap = 0.18;
  const stepW = (CONTENT_W - gap * (count - 1)) / count;
  const trackY = 2.68;
  const target = Math.min(slideSpec.content.targetStage ?? count - 1, count - 1);
  const current = Math.min(slideSpec.content.currentStage ?? 0, count - 1);
  const centreOf = (position: number) => M + position * (stepW + gap) + stepW / 2;

  // The track fills up to the target stage: direction, not a score.
  slide.addShape("rect", {
    x: M,
    y: trackY,
    w: CONTENT_W,
    h: 0.05,
    fill: { color: VIEW.cardBorder },
    line: { color: VIEW.cardBorder, width: 0 },
  });
  slide.addShape("rect", {
    x: M,
    y: trackY,
    w: Math.max(0.1, centreOf(target) - M),
    h: 0.05,
    fill: { color: VIEW.accent },
    line: { color: VIEW.accent, width: 0 },
  });

  stages.forEach((stage, position) => {
    const x = M + position * (stepW + gap);
    const centre = centreOf(position);
    const reached = position <= target;
    const isTarget = position === target;
    const isCurrent = position === current;

    slide.addShape("ellipse", {
      x: centre - 0.2,
      y: trackY - 0.17,
      w: 0.4,
      h: 0.4,
      fill: { color: isTarget ? VIEW.accent : VIEW.card },
      line: { color: isTarget ? VIEW.accent : reached ? C.blue : VIEW.cardBorder, width: 1 },
    });
    addText(slide, String(position + 1), centre - 0.2, trackY - 0.09, 0.4, 0.24, {
      fontSize: 12,
      bold: true,
      color: isTarget ? VIEW.onAccent : cardInk(),
      align: "center",
    });

    slide.addShape("roundRect", {
      x,
      y: 3.22,
      w: stepW,
      h: 2.45,
      fill: { color: VIEW.card },
      line: { color: isTarget ? C.blue : VIEW.cardBorder, width: isTarget ? 1.25 : 0.5 },
      rectRadius: 0.1,
    });
    slide.addShape("rect", {
      x,
      y: 3.22,
      w: stepW,
      h: 0.06,
      fill: { color: reached ? VIEW.series[position % SERIES.length]! : VIEW.cardBorder },
      line: { color: VIEW.cardBorder, width: 0 },
    });
    addText(slide, stage.label, x + 0.16, 3.42, stepW - 0.32, 0.6, {
      fontSize: 14,
      bold: true,
      color: cardInk(),
      fontFace: FONTS.heading,
      valign: "top",
    });
    if (stage.descriptor) {
      addText(slide, stage.descriptor, x + 0.16, 4.05, stepW - 0.32, 1.45, {
        fontSize: 12,
        color: cardMuted(),
      });
    }

    const marker = isTarget ? "TARGET" : isCurrent ? "TODAY" : "";
    if (marker) {
      const markerInk = isTarget ? VIEW.onAccent : cardInk();
      slide.addShape("roundRect", {
        x: centre - 0.52,
        y: 5.86,
        w: 1.04,
        h: 0.28,
        fill: { color: isTarget ? VIEW.accent : VIEW.card },
        line: { color: markerInk, width: 0 },
        rectRadius: 0.08,
      });
      addText(slide, marker, centre - 0.52, 5.89, 1.04, 0.22, {
        fontSize: 12,
        bold: true,
        color: markerInk,
        align: "center",
        charSpacing: 1.2,
      });
    }
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

/** Now, next and later: three outcomes sets with a clear direction of travel. */
function horizonSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { tag: "Horizons", index });
  addRichTitle(slide, slideSpec.actionTitle);
  if (slideSpec.content.layout !== "three-horizon") return;
  tierBadge(slide, slideSpec.tier);

  const horizons = slideSpec.content.horizons.slice(0, 3);
  const gap = 0.28;
  const colW = (CONTENT_W - gap * (horizons.length - 1)) / Math.max(horizons.length, 1);

  horizons.forEach((horizon, position) => {
    const x = M + position * (colW + gap);
    slide.addShape("roundRect", {
      x,
      y: 1.98,
      w: colW,
      h: 4.32,
      fill: { color: VIEW.card },
      line: { color: VIEW.cardBorder, width: 0.75 },
      rectRadius: 0.1,
    });
    slide.addShape("rect", {
      x,
      y: 1.98,
      w: colW,
      h: 0.72,
      fill: { color: VIEW.accent },
      line: { color: VIEW.accent, width: 0 },
    });
    addText(slide, `${position + 1}`, x + 0.16, 2.12, 0.3, 0.4, {
      fontSize: 20,
      bold: true,
      color: VIEW.onAccent,
      fontFace: FONTS.heading,
    });
    addText(slide, horizon.label, x + 0.5, 2.18, colW - 0.66, 0.4, {
      fontSize: 16,
      bold: true,
      color: VIEW.onAccent,
      fontFace: FONTS.heading,
      valign: "middle",
    });
    addText(slide, horizon.description, x + 0.18, 2.88, colW - 0.36, 0.95, {
      fontSize: 12.5,
      color: cardMuted(),
    });
    horizon.outcomes.slice(0, 4).forEach((outcome, itemIndex) => {
      const y = 3.98 + itemIndex * 0.5;
      slide.addShape("ellipse", {
        x: x + 0.2,
        y: y + 0.08,
        w: 0.1,
        h: 0.1,
        fill: { color: VIEW.series[position % SERIES.length]! },
        line: { color: VIEW.cardBorder, width: 0 },
      });
      addText(slide, outcome, x + 0.42, y, colW - 0.62, 0.42, {
        fontSize: 12.5,
        color: cardInk(),
        valign: "middle",
      });
    });
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

/** Stacked platform layers, top of the stack first. */
function layeredSlide(pres: PptxGenJS, slideSpec: DeckSpecSlide, index: number): void {
  const slide = chrome(pres, { tag: "Architecture", index });
  addRichTitle(slide, slideSpec.actionTitle);
  if (slideSpec.content.layout !== "layered-architecture") return;
  tierBadge(slide, slideSpec.tier);

  const layers = slideSpec.content.layers.slice(0, 5);
  const gap = 0.12;
  const top = 1.98;
  const bandH = (4.3 - gap * (layers.length - 1)) / Math.max(layers.length, 1);
  const labelW = 2.75;

  layers.forEach((layer, position) => {
    const y = top + position * (bandH + gap);
    slide.addShape("roundRect", {
      x: M,
      y,
      w: labelW,
      h: bandH,
      fill: { color: VIEW.card },
      line: { color: VIEW.accent, width: 1 },
      rectRadius: 0.08,
    });
    addText(slide, layer.label, M + 0.18, y + 0.08, labelW - 0.36, bandH - 0.16, {
      fontSize: 14,
      bold: true,
      color: cardInk(),
      fontFace: FONTS.heading,
      valign: "middle",
    });
    slide.addShape("roundRect", {
      x: M + labelW + 0.12,
      y,
      w: CONTENT_W - labelW - 0.12,
      h: bandH,
      fill: { color: position % 2 === 0 ? VIEW.rowEven : VIEW.rowOdd },
      line: { color: VIEW.cardBorder, width: 0.5 },
      rectRadius: 0.08,
    });
    addText(
      slide,
      layer.items.join("    ·    "),
      M + labelW + 0.34,
      y + 0.08,
      CONTENT_W - labelW - 0.56,
      bandH - 0.16,
      {
        fontSize: 13,
        color: VIEW.rowInk,
        valign: "middle",
      },
    );
  });
  sourceLine(slide, slideSpec.sourceNote ?? "");
  slide.addNotes(slideSpec.notes);
}

/* -------------------------------------------------------------- traceability --- */

/**
 * Every visible digit must be covered by a claim the slide cites, and no
 * template placeholder may reach a slide. Both are render-time refusals so a
 * regression is caught by a test instead of shipping in the client's file.
 */
export function assertDeckTraceable(spec: DeckSpec): void {
  for (const slide of spec.slides) {
    const texts = [slide.actionTitle, ...visibleStrings(slide.content)];
    for (const text of [...texts, slide.sourceNote ?? "", slide.notes]) {
      if (hasPlaceholders(text)) {
        throw new Error(
          `Deck has an unresolved placeholder on "${slide.actionTitle}": ${text.slice(0, 80)}`,
        );
      }
    }
    for (const text of texts) {
      const untraced = untracedNumbers(text, slide.claimIds, spec.claims);
      if (untraced.length > 0) {
        throw new Error(
          `Deck is not traceable: "${slide.actionTitle}" shows ${untraced.join(", ")} without a cited claim.`,
        );
      }
    }
  }
}

/* -------------------------------------------------------------------- entry --- */

export async function renderDeck(
  spec: DeckSpec,
  coverMeta: DeckCoverMeta,
  config: DeckConfig = {},
): Promise<{ bytes: Uint8Array; pages: number }> {
  return renderDeckSpec(spec, coverMeta, config);
}

/**
 * Keeps the deck within its slide budget. When the planned content overruns,
 * the closing ask (the last slide) is preserved and the middle is trimmed, so
 * the argument still ends where it should.
 */
function capContent(slides: DeckSpecSlide[], budget: number): DeckSpecSlide[] {
  if (slides.length <= budget) return slides;
  return [...slides.slice(0, Math.max(0, budget - 1)), slides[slides.length - 1]!];
}

async function renderDeckSpec(
  spec: DeckSpec,
  coverMeta: DeckCoverMeta,
  config: DeckConfig,
): Promise<{ bytes: Uint8Array; pages: number }> {
  const cfg = resolveDeckConfig(config);
  assertDeckTraceable(spec);
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  pres.author = "Aionos";
  pres.company = "Aionos";
  pres.title = clean(spec.deckTitle).slice(0, 120);
  pres.subject = clean(spec.storyline).slice(0, 200);
  pres.theme = { headFontFace: cfg.headingFont, bodyFontFace: cfg.bodyFont };

  EYEBROW = clean(coverMeta.industry || "");
  FOOTER = clean(cfg.footer);
  setSurface("light");

  // Cover, then the planned content on white, then the deep-navy closing. The
  // total is capped: the cover and the closing each cost one slide.
  const maxSlides = T.config.maxSlides;
  const content = capContent(spec.slides, maxSlides - 2);
  let pageNumber = 1;
  cover(pres, spec, coverMeta, pageNumber, config.clientLogo ?? null);

  content.forEach((slideSpec, position) => {
    pageNumber += 1;
    const index = pageNumber;
    SLIDE_NUMBER = sectionNumber(position);
    // Section dividers sit on the solid deep-navy ground; every other content
    // slide is white. The ground is chosen by layout, not by page parity.
    setSurface(slideSpec.content.layout === "section-divider" ? "navy" : "light");
    switch (slideSpec.content.layout) {
      case "section-divider":
        divider(pres, slideSpec, index);
        break;
      case "context-bullets":
        bulletsSlide(pres, slideSpec, index);
        break;
      case "kpi-cards":
        kpiSlide(pres, slideSpec, spec, index);
        break;
      case "partner-hub":
        hubSlide(pres, slideSpec, index);
        break;
      case "two-column-compare":
      case "before-after":
        compareSlide(pres, slideSpec, index);
        break;
      case "table-compact":
        tableSlide(pres, slideSpec, "Offer", index);
        break;
      case "shortcomings-table":
        tableSlide(pres, slideSpec, "Risks", index);
        break;
      case "collaboration-pointers-table":
        tableSlide(pres, slideSpec, "Partners", index);
        break;
      case "process-roadmap":
        roadmapSlide(pres, slideSpec, index);
        break;
      case "chart-with-takeaway":
        chartSlide(pres, slideSpec, spec, index);
        break;
      case "image-with-caption":
        imageSlide(pres, slideSpec, index);
        break;
      case "next-steps-ask":
        askSlide(pres, slideSpec, index);
        break;
      case "maturity-progression":
        maturitySlide(pres, slideSpec, index);
        break;
      case "three-horizon":
        horizonSlide(pres, slideSpec, index);
        break;
      case "layered-architecture":
        layeredSlide(pres, slideSpec, index);
        break;
    }
  });

  if (pageNumber < maxSlides) {
    pageNumber += 1;
    closingSlide(pres, spec, coverMeta, pageNumber);
  }

  const pages = (pres as unknown as { slides: unknown[] }).slides.length;
  const output = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return {
    bytes: normalizeDeckPackage(new Uint8Array(output), {
      primary: BLUE_HEX,
      accent: AIONOS_TOKENS.warm_clay,
    }),
    pages,
  };
}
