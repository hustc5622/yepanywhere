import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OfficePreviewError,
  convertOfficeDocument,
} from "../../src/file-preview/office.js";
import { createFsRoutes } from "../../src/routes/fs.js";

/** Minimal ZIP writer (deflate, no CRC check needed by the reader). */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(text, "utf8");
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const docx = () =>
  zip({
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Plan &amp; &lt;scope&gt;</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">First </w:t></w:r><w:r><w:t>line</w:t><w:br/><w:t>second</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>item one</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>item two</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:delText>removed</w:delText><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p>
    </w:body></w:document>`,
  });

const xlsx = () =>
  zip({
    "_rels/.rels":
      '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":
      '<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<x:Relationships xmlns:x="x"><x:Relationship Id="rId1" Target="worksheets/sheet1.xml"/><x:Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></x:Relationships>',
    "xl/sharedStrings.xml":
      "<sst><si><t>Name</t></si><si><r><t>Bo</t></r><r><t>b</t></r></si></sst>",
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Score</t></is></c></row>
      <row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" t="b"><v>1</v></c><c r="C3"><v>42.5</v></c></row>
      <row r="4"><c r="A4"/></row>
    </sheetData></worksheet>`,
    "xl/worksheets/sheet2.xml": "<worksheet><sheetData/></worksheet>",
  });

const pptx = () =>
  zip({
    "ppt/presentation.xml":
      '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels":
      '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
    "ppt/slides/slide1.xml":
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:pPr/><a:r><a:t>Gold </a:t></a:r><a:r><a:t>Trend</a:t></a:r></a:p><a:p><a:r><a:t>2024</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    "ppt/slides/slide2.xml":
      '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Thanks</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  });

describe("office conversion", () => {
  it("renders docx headings, paragraphs, lists and tables as escaped HTML", () => {
    const result = convertOfficeDocument(docx(), "docx");
    expect(result.format).toBe("docx");
    if (result.format !== "docx") return;
    expect(result.html).toContain("<h1>Plan &amp; &lt;scope&gt;</h1>");
    expect(result.html).toContain("<p>First line<br>second</p>");
    expect(result.html).toContain(
      "<ul>\n<li>item one</li>\n<li>item two</li>\n</ul>",
    );
    expect(result.html).toContain("<tr><td>A1</td><td>B1</td></tr>");
    expect(result.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(result.html).not.toContain("<script");
    expect(result.html).not.toContain("removed");
  });

  it("reads xlsx sheets through relationships with shared and inline strings", () => {
    const result = convertOfficeDocument(xlsx(), "xlsx");
    if (result.format !== "xlsx") throw new Error("expected xlsx");
    expect(result.sheets.map((sheet) => sheet.name)).toEqual(["Data", "Other"]);
    expect(result.sheets[0]?.rows).toEqual([
      ["Name", "", "Score"],
      ["", "", ""],
      ["Bob", "TRUE", "42.5"],
    ]);
    expect(result.sheets[1]?.rows).toEqual([]);
  });

  it("extracts pptx slide paragraphs in presentation order", () => {
    const result = convertOfficeDocument(pptx(), "pptx");
    if (result.format !== "pptx") throw new Error("expected pptx");
    expect(result.slides).toEqual([
      { paragraphs: ["Gold Trend", "2024"] },
      { paragraphs: ["Thanks"] },
    ]);
  });

  it("rejects files that are not OOXML packages", () => {
    expect(() =>
      convertOfficeDocument(Buffer.from("not a zip at all, just text"), "docx"),
    ).toThrow(OfficePreviewError);
    expect(() => convertOfficeDocument(zip({ "a.txt": "x" }), "xlsx")).toThrow(
      /may be encrypted/,
    );
  });
});

describe("/api/fs/preview office documents", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-office-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("attaches the conversion, or the reason it failed", async () => {
    const routes = createFsRoutes({
      scanner: { getProject: async () => null, listProjects: async () => [] },
    });
    const good = path.join(tempDir, "plan.docx");
    const bad = path.join(tempDir, "broken.xlsx");
    await writeFile(good, docx());
    await writeFile(bad, "nope");

    const ok = await (
      await routes.request(`/preview?path=${encodeURIComponent(good)}`)
    ).json();
    expect(ok.kind).toBe("office");
    expect(ok.office.format).toBe("docx");

    const failed = await (
      await routes.request(`/preview?path=${encodeURIComponent(bad)}`)
    ).json();
    expect(failed.office).toBeUndefined();
    expect(failed.officeError).toBe("Not a ZIP archive");
  });
});
