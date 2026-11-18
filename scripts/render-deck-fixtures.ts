/**
 * Renders the review fixtures through the real PPTX renderer.
 *
 *   bun scripts/render-deck-fixtures.ts
 *
 * Output: samples/deck-review/{movin,indigo}.pptx plus a layout map printed to
 * stdout, so a reviewer can see which layout each slide got without opening the
 * file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { renderPptx } from "../src/lib/documents/render/pptx";
import { indigoDeck, movinDeck } from "../tests/deck-fixtures";

type Job = { name: string; model: ReturnType<typeof movinDeck> };

const outDir = "samples/deck-review";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Which master/layout each slide is based on, read back from the package. */
function layoutMap(bytes: Uint8Array): string[] {
  const parts = unzipSync(bytes);
  const layouts = Object.entries(parts)
    .filter(([name]) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .map(([name, data]) => {
      const match = /name="([^"]*)"/.exec(decode(data));
      return { name, label: match?.[1] ?? name };
    });
  const relTargets = new Map<string, string>();
  for (const [name, data] of Object.entries(parts)) {
    const relsMatch = /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/.exec(name);
    if (!relsMatch) continue;
    const target = /slideLayout(\d+)\.xml/.exec(decode(data));
    if (target) relTargets.set(relsMatch[1] ?? "", `slideLayout${target[1]}.xml`);
  }
  const slideNames = Object.keys(parts)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")));
  return slideNames.map((name) => {
    const index = name.replace(/\D/g, "");
    const target = relTargets.get(index);
    const label =
      layouts.find((layout) => layout.name.endsWith(target ?? "__none__"))?.label ?? "?";
    const text = decode(parts[name] ?? new Uint8Array());
    const title = /<a:t>([^<]*)<\/a:t>/.exec(text)?.[1] ?? "(no title)";
    return `${index.padStart(2, "0")}  ${label.padEnd(24)} ${title.slice(0, 72)}`;
  });
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const jobs: Job[] = [
    { name: "movin", model: movinDeck() },
    { name: "indigo", model: indigoDeck() },
  ];
  for (const job of jobs) {
    const { bytes, pages } = await renderPptx(job.model);
    const file = `${outDir}/${job.name}.pptx`;
    writeFileSync(file, bytes);
    const parts = unzipSync(bytes);
    const charts = Object.keys(parts).filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    const layouts = Object.keys(parts).filter((name) =>
      /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name),
    );
    console.log(
      `\n${job.name}: ${pages} slides, ${charts.length} native charts, ${layouts.length} layouts`,
    );
    for (const line of layoutMap(bytes)) console.log(`  ${line}`);
  }
}

await main();
