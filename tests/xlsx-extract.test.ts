/**
 * Spreadsheets were the one supported-looking format that never reached the
 * index: the worker skipped them, so ten workbooks held zero chunks. These
 * tests pin the native reader — sheet names as headings, pipe-delimited rows
 * whose first line stays a header, and the number formats that make a cell
 * mean something ("0.05" is 5%, "45292" is a date, not a quantity).
 */
import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { documentFormat } from "../src/lib/document-format";
import { extractDocument } from "../src/lib/rag/extract";
import { buildChunkRows } from "../src/lib/rag/ingest";

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Risk &amp; Control" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;

const SHARED = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst><si><t>Risk ID</t></si><si><t>Likelihood</t></si><si><t>Review date</t></si><si><t>R-001</t></si><si><t>only the third column is filled</t></si></sst>`;

// Style 1 is the built-in percent format (id 9), style 2 the short date (id 14).
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="14"/></cellXfs></styleSheet>`;

const SHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
  <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>0.35</v></c><c r="C2" s="2"><v>45292</v></c></row>
  <row r="3"><c r="C3" t="s"><v>4</v></c></row>
  <row r="4"><c r="A4"><f>SUM(B2)</f><v>0.35</v></c><c r="B4" t="e"><v>#DIV/0!</v></c></row>
</sheetData></worksheet>`;

function workbookBytes(): Uint8Array {
  return zipSync({
    "xl/workbook.xml": strToU8(WORKBOOK),
    "xl/_rels/workbook.xml.rels": strToU8(RELS),
    "xl/sharedStrings.xml": strToU8(SHARED),
    "xl/styles.xml": strToU8(STYLES),
    "xl/worksheets/sheet1.xml": strToU8(SHEET),
  });
}

describe("xlsx extraction", () => {
  test("recognises the format by extension and by mime type", () => {
    expect(documentFormat("Risk register.xlsx")).toBe("xlsx");
    expect(
      documentFormat(
        "no-extension",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("xlsx");
  });

  test("a sheet becomes a table section headed by its name", async () => {
    const result = await extractDocument("Risks.xlsx", "", workbookBytes());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.document.format).toBe("xlsx");
    expect(result.document.sections).toHaveLength(1);
    const [sheet] = result.document.sections;
    expect(sheet?.heading).toBe("Risk & Control");
    expect(sheet?.kind).toBe("table");
    expect(sheet?.metadata).toMatchObject({ source: "sheet", rows: 4, columns: 3 });
  });

  test("rows keep their columns, and headers stay the first line", async () => {
    const result = await extractDocument("Risks.xlsx", "", workbookBytes());
    if (!result.ok) throw new Error(result.error);
    const lines = result.document.sections[0]!.text.split("\n");

    expect(lines[0]).toBe("Risk ID | Likelihood | Review date");
    expect(lines[1]).toBe("R-001 | 35% | 2024-01-01");
    // A sparse row is padded so it still lines up under the header.
    expect(lines[2]).toBe("|  | only the third column is filled");
    // A formula contributes its cached value; the error cell beside it is dropped.
    expect(lines[3]).toBe("0.35");
  });

  test("percent cells read as percentages, dates as dates, errors are dropped", async () => {
    const result = await extractDocument("Risks.xlsx", "", workbookBytes());
    if (!result.ok) throw new Error(result.error);
    const text = result.document.sections[0]!.text;

    expect(text).not.toContain("45292");
    expect(text).not.toContain("#DIV/0!");
    // A formula contributes its cached value only, never the formula text.
    expect(text).not.toContain("SUM(");
    expect(text).toContain("35% | 2024-01-01");
  });

  test("chunking repeats the header on continuation chunks", async () => {
    const result = await extractDocument("Risks.xlsx", "", workbookBytes());
    if (!result.ok) throw new Error(result.error);
    const rows = buildChunkRows("xlsx", result.document.sections, "Risks.xlsx", {
      title: "Risk register",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.chunk_kind).toBe("table");
    expect(rows[0]?.content).toStartWith("Document: Risk register");
    expect(rows[0]?.content).toContain("Risk ID | Likelihood | Review date");
    // Sheet number is provenance the row does not claim as a slide.
    expect(rows[0]?.slide).toBeNull();
    expect(rows[0]?.page).toBeNull();
  });

  test("a file that is not a workbook fails loudly instead of indexing nothing", async () => {
    const notAWorkbook = zipSync({ "xl/worksheets/sheet1.xml": strToU8(SHEET) });
    const result = await extractDocument("Broken.xlsx", "", notAWorkbook);
    expect(result.ok).toBe(false);
  });
});
