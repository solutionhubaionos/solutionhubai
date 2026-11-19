/**
 * PptxGenJS declares one `/ppt/slideMasters/slideMasterN.xml` content-type
 * override per slide, but writes a single master part. PowerPoint opens such a
 * file because it follows relationships, not content types; strict readers such
 * as the `pptx-preview` engine behind the in-app viewer throw while loading the
 * declared-but-missing part and render nothing at all.
 *
 * The declaration adds nothing, so drop the overrides whose part is not in the
 * archive. Anything genuinely missing is still dropped here, which keeps the
 * package internally consistent.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const OVERRIDE = /<Override\b[^>]*\/>/g;
const PART_NAME = /PartName="([^"]+)"/;
const CONTENT_TYPES = "[Content_Types].xml";

export function dropDanglingOverrides(bytes: Uint8Array): Uint8Array {
  const parts = unzipSync(bytes);
  const declared = parts[CONTENT_TYPES];
  if (!declared) return bytes;

  const present = new Set(Object.keys(parts));
  let changed = false;
  const xml = strFromU8(declared).replace(OVERRIDE, (tag) => {
    const name = PART_NAME.exec(tag)?.[1];
    if (!name) return tag;
    if (present.has(name.replace(/^\//, ""))) return tag;
    changed = true;
    return "";
  });
  if (!changed) return bytes;

  parts[CONTENT_TYPES] = strToU8(xml);
  return zipSync(parts);
}

/** Writes the house accents into the Office theme, so a reused file keeps them. */
function themedXml(xml: string, colours: { primary: string; accent: string }): string {
  let themed = xml;
  for (const [name, value] of [
    ["accent1", colours.primary],
    ["accent2", colours.accent],
  ] as const) {
    themed = themed.replace(
      new RegExp(`(<a:${name}>)[\\s\\S]*?(</a:${name}>)`),
      `$1<a:srgbClr val="${value}"/>$2`,
    );
  }
  return themed;
}

/**
 * The final deck package pass: brand the Office theme, drop content-type
 * overrides whose part is absent (see `dropDanglingOverrides`), and move the
 * notes-master list ahead of the slide list and dimensions as ECMA-376
 * requires. Any step that cannot find its part is skipped, so a missing one
 * costs nothing.
 */
export function normalizeDeckPackage(
  bytes: Uint8Array,
  colours?: { primary: string; accent: string },
): Uint8Array {
  const files = unzipSync(bytes);

  const scheme = files["ppt/theme/theme1.xml"];
  if (colours && scheme)
    files["ppt/theme/theme1.xml"] = strToU8(themedXml(strFromU8(scheme), colours));

  const declared = files[CONTENT_TYPES];
  if (declared) {
    const present = new Set(Object.keys(files));
    files[CONTENT_TYPES] = strToU8(
      strFromU8(declared).replace(OVERRIDE, (tag) => {
        const name = PART_NAME.exec(tag)?.[1];
        if (!name) return tag;
        return present.has(name.replace(/^\//, "")) ? tag : "";
      }),
    );
  }

  const presentation = files["ppt/presentation.xml"];
  if (presentation) {
    let xml = strFromU8(presentation);
    const notes = /<p:notesMasterIdLst\b[^>]*>[\s\S]*?<\/p:notesMasterIdLst>/.exec(xml)?.[0];
    if (notes) {
      xml = xml.replace(notes, "");
      const anchor = /<p:(?:handoutMasterIdLst|sldIdLst|sldSz)\b/.exec(xml)?.index;
      if (anchor !== undefined) xml = xml.slice(0, anchor) + notes + xml.slice(anchor);
    }
    files["ppt/presentation.xml"] = strToU8(xml);
  }

  return zipSync(files);
}
