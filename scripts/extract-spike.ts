/**
 * Phase 0 extraction spike.
 * Usage: bun scripts/extract-spike.ts <folder-of-library-files>
 * Writes per-file chunks to the git-ignored spike-output/ directory.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { chunkSections, type Chunk } from "../src/lib/rag/chunk";
import { extractDocument } from "../src/lib/rag/extract";

const SUPPORTED = new Set([".pdf", ".docx", ".pptx"]);

type SummaryEntry = {
  sourceFile: string;
  format: string;
  chunks: number;
  emptyUnits: Array<{ pageOrSlide: number | null; heading: string | null }>;
  warnings: string[];
  error: string | null;
};

type Sample = { format: string; sourceFile: string; chunk: Chunk };

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [path] : [];
  });
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function pickSamples(samples: Sample[]): Sample[] {
  const picked: Sample[] = [];
  const formats = new Set<string>();
  for (const sample of samples) {
    if (formats.has(sample.format)) continue;
    formats.add(sample.format);
    picked.push(sample);
  }
  for (const sample of samples) {
    if (picked.length >= 5) break;
    if (!picked.includes(sample)) picked.push(sample);
  }
  return picked.slice(0, 5);
}

function printReport(summary: SummaryEntry[], samples: Sample[]) {
  console.log("file\tformat\tchunks\tempty pages/slides\tstatus");
  for (const entry of summary) {
    const empty = entry.emptyUnits
      .map((unit) => unit.pageOrSlide ?? unit.heading ?? "?")
      .join(", ");
    const status = entry.error ? `FAILED: ${entry.error}` : "ok";
    console.log(
      `${entry.sourceFile}\t${entry.format}\t${entry.chunks}\t${empty || "-"}\t${status}`,
    );
    for (const warning of entry.warnings) console.log(`  warning: ${warning}`);
  }

  const failed = summary.filter((entry) => entry.error);
  const withEmpty = summary.filter((entry) => entry.emptyUnits.length > 0);
  console.log(
    `\n${summary.length} files, ${summary.reduce((total, entry) => total + entry.chunks, 0)} chunks, ` +
      `${failed.length} failed, ${withEmpty.length} with low-text pages/slides.`,
  );

  console.log("\nSample chunks:");
  for (const sample of samples) {
    console.log(
      JSON.stringify(
        {
          format: sample.format,
          sourceFile: sample.sourceFile,
          pageOrSlide: sample.chunk.pageOrSlide,
          heading: sample.chunk.heading,
          chunkIndex: sample.chunk.chunkIndex,
          estimatedTokens: sample.chunk.estimatedTokens,
          content: sample.chunk.content.slice(0, 500),
        },
        null,
        2,
      ),
    );
  }
}

async function main() {
  const inputDir = resolve(process.argv[2] ?? "spike-input");
  const outputDir = resolve("spike-output");

  if (!existsSync(inputDir)) {
    console.error(`Folder not found: ${inputDir}`);
    console.error("Usage: bun scripts/extract-spike.ts <folder-of-library-files>");
    process.exit(1);
  }

  const allFiles = walk(inputDir);
  const files = allFiles.filter((file) => SUPPORTED.has(extname(file).toLowerCase()));
  if (files.length === 0) {
    console.error(`No PDF, DOCX or PPTX files found in ${inputDir}`);
    process.exit(1);
  }

  const summary: SummaryEntry[] = [];
  const samples: Sample[] = [];

  for (const file of files) {
    const sourceFile = relative(inputDir, file);
    const bytes = new Uint8Array(readFileSync(file));
    const result = await extractDocument(sourceFile, "", bytes);
    const outputPath = join(outputDir, `${sourceFile}.json`);

    if (!result.ok) {
      const entry: SummaryEntry = {
        sourceFile,
        format: result.format,
        chunks: 0,
        emptyUnits: [],
        warnings: [],
        error: result.error,
      };
      summary.push(entry);
      writeJson(outputPath, entry);
      continue;
    }

    const chunks = chunkSections(result.document.sections, { sourceFile });
    const entry: SummaryEntry = {
      sourceFile,
      format: result.document.format,
      chunks: chunks.length,
      emptyUnits: result.document.emptyUnits,
      warnings: result.document.warnings,
      error: null,
    };
    summary.push(entry);
    writeJson(outputPath, {
      sourceFile,
      format: result.document.format,
      chunks,
      emptyUnits: result.document.emptyUnits,
      warnings: result.document.warnings,
    });

    const first = chunks[0];
    if (first) {
      samples.push({ format: result.document.format, sourceFile, chunk: first });
    }
  }

  writeJson(join(outputDir, "summary.json"), {
    inputDir,
    skippedUnsupported: allFiles.length - files.length,
    files: summary,
  });

  if (allFiles.length > files.length) {
    console.log(`Skipped ${allFiles.length - files.length} unsupported file(s).`);
  }
  console.log(`Wrote per-file chunks to ${relative(process.cwd(), outputDir)}/`);
  printReport(summary, pickSamples(samples));
}

void main();
