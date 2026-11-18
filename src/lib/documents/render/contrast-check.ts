/**
 * Reads a rendered PPTX package and verifies every text run's colour against
 * the Aionos contrast table, using the slide's background as the effective
 * backdrop (the theme paints every slide navy). It is deliberately conservative:
 * it knows the run colours and the slide background, and allows navy text when
 * the slide carries a light shape fill for it to sit on.
 */
import { checkTextPair, PALETTE } from "../contrast";

export type ContrastFinding = { slide: string; text: string; reason: string };

const DEFAULT_BG = "1C2453";
const LIGHT_FILL = /val="(?:F5F4F1|D2D7E2|EDEDED|BAD6FF|FFAF75|00ECFF)"/i;

function slideBackground(xml: string): string {
  return xml.match(/<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1]?.toUpperCase() ?? DEFAULT_BG;
}

/** The first solid-fill colour inside each text-run properties block. */
function runColours(xml: string): string[] {
  const colours: string[] = [];
  for (const block of xml.match(/<a:rPr\b[\s\S]*?<\/a:rPr>/g) ?? []) {
    const value = block.match(/<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1];
    if (value) colours.push(value.toUpperCase());
  }
  return colours;
}

export function checkDeckContrast(
  parts: Record<string, Uint8Array>,
): ContrastFinding[] {
  const findings: ContrastFinding[] = [];
  const decoder = new TextDecoder();
  for (const [name, data] of Object.entries(parts)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    const xml = decoder.decode(data);
    const background = slideBackground(xml);
    const hasLightFill = LIGHT_FILL.test(xml);
    for (const colour of runColours(xml)) {
      if (colour === PALETTE.navy.replace("#", "") && hasLightFill) continue;
      const verdict = checkTextPair(colour, background);
      if (!verdict.ok) findings.push({ slide: name, text: colour, reason: verdict.reason });
    }
  }
  return findings;
}
