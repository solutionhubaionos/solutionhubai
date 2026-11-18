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
