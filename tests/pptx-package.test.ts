/**
 * Regression guard for the blank black PPTX preview. PptxGenJS declares one
 * slide-master content-type part per slide but writes only the single master it
 * was given; PowerPoint opens the file anyway, while the `pptx-preview` engine
 * used by the in-app viewer aborted and rendered an empty black frame.
 */
import { describe, expect, test } from "bun:test";
import PptxGenJS from "pptxgenjs";
import { strFromU8, unzipSync } from "fflate";
import { dropDanglingOverrides } from "../src/lib/documents/render/pptx-package";

function danglingOverrides(bytes: Uint8Array): string[] {
  const parts = unzipSync(bytes);
  const types = strFromU8(parts["[Content_Types].xml"]!);
  const declared = [...types.matchAll(/PartName="([^"]+)"/g)].map((match) =>
    match[1]!.replace(/^\//, ""),
  );
  return declared.filter((name) => !parts[name]);
}

async function threeSlideDeck(): Promise<Uint8Array> {
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  for (let index = 0; index < 3; index += 1) {
    pres.addSlide().addText(`Slide ${index + 1}`, { x: 1, y: 1, w: 6, h: 1 });
  }
  const output = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return new Uint8Array(output);
}

describe("pptx package content types", () => {
  test("drops overrides for parts the package does not contain", async () => {
    const raw = await threeSlideDeck();
    // The upstream writer really does declare masters it never writes.
    expect(danglingOverrides(raw).length).toBeGreaterThan(0);

    const fixed = dropDanglingOverrides(raw);
    expect(danglingOverrides(fixed)).toEqual([]);
    // The slides themselves must survive the rewrite.
    const parts = unzipSync(fixed);
    expect(
      Object.keys(parts).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)),
    ).toHaveLength(3);
  });

  test("leaves a consistent package untouched", async () => {
    const fixed = dropDanglingOverrides(await threeSlideDeck());
    expect(dropDanglingOverrides(fixed)).toBe(fixed);
  });
});
