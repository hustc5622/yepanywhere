/**
 * Lightweight previews for Office Open XML documents (docx / xlsx / pptx).
 *
 * No third-party dependency: OOXML files are ZIP archives of XML parts, so a
 * small central-directory reader plus tag scanning is enough to extract text,
 * tables and sheet cells. The output is meant for a quick read in the side
 * panel, not a faithful rendering — styling, images, charts and formulas are
 * dropped. All generated HTML is built from escaped text and a fixed tag set.
 */

import { inflateRawSync } from "node:zlib";
import type {
  OfficeDocumentPreview,
  OfficeSheetPreview,
  OfficeSlidePreview,
} from "@yep-anywhere/shared";

/** Largest office file we try to convert. */
export const MAX_OFFICE_FILE_BYTES = 30 * 1024 * 1024;
/** Largest single decompressed part (guards against zip bombs). */
const MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_DOCX_BLOCKS = 3000;
const MAX_SHEETS = 20;
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLUMNS = 50;
const MAX_SLIDES = 300;

export class OfficePreviewError extends Error {}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

interface ZipEntry {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>();

  constructor(private readonly buffer: Buffer) {
    const eocd = this.findEndOfCentralDirectory();
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    if (offset === 0xffffffff) {
      throw new OfficePreviewError("ZIP64 archives are not supported");
    }
    for (let i = 0; i < count; i++) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) {
        throw new OfficePreviewError("Corrupt ZIP central directory");
      }
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const name = buffer.toString(
        "utf8",
        offset + 46,
        offset + 46 + nameLength,
      );
      this.entries.set(name, {
        method: buffer.readUInt16LE(offset + 10),
        compressedSize: buffer.readUInt32LE(offset + 20),
        uncompressedSize: buffer.readUInt32LE(offset + 24),
        localHeaderOffset: buffer.readUInt32LE(offset + 42),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
  }

  private findEndOfCentralDirectory(): number {
    const min = Math.max(0, this.buffer.length - 0xffff - 22);
    for (let i = this.buffer.length - 22; i >= min; i--) {
      if (this.buffer.readUInt32LE(i) === 0x06054b50) return i;
    }
    throw new OfficePreviewError("Not a ZIP archive");
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  readText(name: string): string | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    if (entry.uncompressedSize > MAX_PART_BYTES) {
      throw new OfficePreviewError("Document part is too large to preview");
    }
    const header = entry.localHeaderOffset;
    if (this.buffer.readUInt32LE(header) !== 0x04034b50) {
      throw new OfficePreviewError("Corrupt ZIP entry");
    }
    const start =
      header +
      30 +
      this.buffer.readUInt16LE(header + 26) +
      this.buffer.readUInt16LE(header + 28);
    const data = this.buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data.toString("utf8");
    if (entry.method === 8) {
      return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }).toString(
        "utf8",
      );
    }
    throw new OfficePreviewError(
      `Unsupported ZIP compression (${entry.method})`,
    );
  }
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

export function decodeXmlText(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (_, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[
        entity as "amp"
      ];
    },
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match?.[1] === undefined ? undefined : decodeXmlText(match[1]);
}

/**
 * Element name pattern accepting any namespace prefix (`x:row`, `row`). The
 * lookahead keeps `p` from matching `p:sp` or `a:pPr`.
 */
function el(local: string): string {
  return `(?:[A-Za-z0-9_]+:)?${local}(?![\\w:])`;
}

function elements(xml: string, local: string): RegExpMatchArray[] {
  const re = new RegExp(
    `<${el(local)}([^>]*?)(?:/>|>([\\s\\S]*?)</${el(local)}>)`,
    "g",
  );
  return [...xml.matchAll(re)];
}

function emptyElements(xml: string, local: string): string[] {
  const re = new RegExp(`<${el(local)}([^>]*?)/?>`, "g");
  return [...xml.matchAll(re)].map((match) => match[1] ?? "");
}

/** Relationship id attribute (`r:id`, `ns1:id`, …). */
function relId(attrs: string): string | undefined {
  return /(?:^|\s)[A-Za-z0-9_]+:id="([^"]*)"/.exec(attrs)?.[1];
}

/** Concatenated text of every `<t>` element (any prefix) in a fragment. */
function collectText(xml: string, local: string): string {
  return elements(xml, local)
    .map((match) => decodeXmlText(match[2] ?? ""))
    .join("");
}

function relationships(xml: string): string[] {
  return emptyElements(xml, "Relationship");
}

/** Main document part from the package relationships, with a fallback. */
function mainPart(zip: ZipArchive, fallback: string): string {
  for (const attrs of relationships(zip.readText("_rels/.rels") ?? "")) {
    if (attr(attrs, "Type")?.endsWith("/officeDocument")) {
      const target = attr(attrs, "Target");
      if (target) return resolvePartPath("", target);
    }
  }
  return fallback;
}

function readMainPart(zip: ZipArchive, fallback: string, label: string) {
  const path = mainPart(zip, fallback);
  const xml = zip.readText(path);
  if (xml === undefined) {
    throw new OfficePreviewError(
      `Missing ${label} part (the file may be encrypted)`,
    );
  }
  return { path, xml };
}

/** Map relationship ids to part paths for `<dir>/_rels/<file>.rels`. */
function readRelationships(
  zip: ZipArchive,
  partPath: string,
): Map<string, string> {
  const slash = partPath.lastIndexOf("/");
  const dir = partPath.slice(0, slash);
  const file = partPath.slice(slash + 1);
  const xml = zip.readText(`${dir}/_rels/${file}.rels`) ?? "";
  const rels = new Map<string, string>();
  for (const attrs of relationships(xml)) {
    const id = attr(attrs, "Id");
    const target = attr(attrs, "Target");
    if (!id || !target) continue;
    rels.set(id, resolvePartPath(dir, target));
  }
  return rels;
}

function resolvePartPath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir ? baseDir.split("/") : [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

// ---------------------------------------------------------------------------
// docx
// ---------------------------------------------------------------------------

interface DocParagraph {
  type: "p";
  text: string;
  heading?: number;
  list: boolean;
}
interface DocTable {
  type: "table";
  rows: string[][];
}
type DocBlock = DocParagraph | DocTable;

function headingLevel(style: string | undefined): number | undefined {
  if (!style) return undefined;
  if (/^title$/i.test(style)) return 1;
  const match = /heading\s*([1-6])/i.exec(style);
  return match ? Number(match[1]) : undefined;
}

export function convertDocx(zip: ZipArchive): OfficeDocumentPreview {
  const { xml } = readMainPart(zip, "word/document.xml", "document");

  const blocks: DocBlock[] = [];
  // Stack of open tables; each row is a list of cells, each cell a list of
  // paragraph texts.
  const tables: string[][][][] = [];
  let paragraph: DocParagraph | null = null;
  let inText = false;
  let truncated = false;

  const re = /<(\/?)([A-Za-z0-9]+:[A-Za-z0-9]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  for (const match of xml.matchAll(re)) {
    const [, closing, tag, attrs = "", selfClosing, text] = match;
    if (text !== undefined) {
      if (inText && paragraph) paragraph.text += decodeXmlText(text);
      continue;
    }
    if (blocks.length >= MAX_DOCX_BLOCKS) {
      truncated = true;
      break;
    }
    const open = !closing;
    switch (tag) {
      case "w:p":
        if (open && !selfClosing)
          paragraph = { type: "p", text: "", list: false };
        else if (!open && paragraph) {
          const table = tables.at(-1);
          const cell = table?.at(-1)?.at(-1);
          if (cell) cell.push(paragraph.text);
          else if (paragraph.text.trim()) blocks.push(paragraph);
          paragraph = null;
        }
        break;
      case "w:pStyle":
        if (paragraph) paragraph.heading = headingLevel(attr(attrs, "w:val"));
        break;
      case "w:numPr":
        if (paragraph && open) paragraph.list = true;
        break;
      case "w:t":
        inText = open && !selfClosing;
        break;
      case "w:tab":
        if (paragraph && open) paragraph.text += "\t";
        break;
      case "w:br":
      case "w:cr":
        if (paragraph && open) paragraph.text += "\n";
        break;
      case "w:tbl":
        if (open) tables.push([]);
        else {
          const rows = tables.pop() ?? [];
          const flat = rows.map((row) => row.map((cell) => cell.join("\n")));
          const parentCell = tables.at(-1)?.at(-1)?.at(-1);
          if (parentCell) {
            parentCell.push(flat.map((row) => row.join(" | ")).join("\n"));
          } else blocks.push({ type: "table", rows: flat });
        }
        break;
      case "w:tr":
        if (open) tables.at(-1)?.push([]);
        break;
      case "w:tc":
        if (open) tables.at(-1)?.at(-1)?.push([]);
        break;
    }
  }

  return { format: "docx", html: renderDocBlocks(blocks), truncated };
}

function renderInline(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function renderDocBlocks(blocks: DocBlock[]): string {
  const html: string[] = [];
  let inList = false;
  for (const block of blocks) {
    const isListItem = block.type === "p" && block.list && !block.heading;
    if (inList && !isListItem) {
      html.push("</ul>");
      inList = false;
    }
    if (block.type === "table") {
      const rows = block.rows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`,
        )
        .join("");
      html.push(
        `<div class="markdown-table-wrapper"><table><tbody>${rows}</tbody></table></div>`,
      );
    } else if (block.heading) {
      html.push(
        `<h${block.heading}>${renderInline(block.text)}</h${block.heading}>`,
      );
    } else if (isListItem) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${renderInline(block.text)}</li>`);
    } else {
      html.push(`<p>${renderInline(block.text)}</p>`);
    }
  }
  if (inList) html.push("</ul>");
  return html.join("\n");
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0]?.toUpperCase() ?? "";
  let index = 0;
  for (const letter of letters)
    index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function readSharedStrings(zip: ZipArchive): string[] {
  const xml = zip.readText("xl/sharedStrings.xml");
  if (!xml) return [];
  return elements(xml, "si").map((match) => collectText(match[2] ?? "", "t"));
}

function parseSheet(
  xml: string,
  name: string,
  shared: string[],
): OfficeSheetPreview {
  const rows: string[][] = [];
  let totalRows = 0;
  let truncatedColumns = false;
  let nextRow = 0;
  const valueRe = new RegExp(`<${el("v")}[^>]*>([\\s\\S]*?)</${el("v")}>`);
  for (const rowMatch of elements(xml, "row")) {
    const rowNumber = Number(attr(rowMatch[1] ?? "", "r")) || nextRow + 1;
    nextRow = rowNumber;
    totalRows = Math.max(totalRows, rowNumber);
    if (rowNumber > MAX_SHEET_ROWS) continue;
    const cells: string[] = [];
    let nextColumn = 0;
    for (const cellMatch of elements(rowMatch[2] ?? "", "c")) {
      const cellAttrs = cellMatch[1] ?? "";
      const ref = attr(cellAttrs, "r");
      const column = ref ? columnIndex(ref) : nextColumn;
      nextColumn = column + 1;
      if (column >= MAX_SHEET_COLUMNS) {
        truncatedColumns = true;
        continue;
      }
      const body = cellMatch[2] ?? "";
      const type = attr(cellAttrs, "t");
      const raw = decodeXmlText(valueRe.exec(body)?.[1] ?? "");
      let value: string;
      if (type === "s") value = shared[Number(raw)] ?? "";
      else if (type === "inlineStr") value = collectText(body, "t");
      else if (type === "b") value = raw === "1" ? "TRUE" : raw ? "FALSE" : "";
      else value = raw;
      while (cells.length < column) cells.push("");
      cells[column] = value;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = cells;
  }
  // Drop trailing empty rows and pad to a rectangle.
  while (rows.length > 0 && (rows.at(-1)?.every((cell) => !cell) ?? true)) {
    rows.pop();
  }
  const width = Math.max(0, ...rows.map((row) => row.length));
  return {
    name,
    rows: rows.map((row) => [
      ...row,
      ...Array<string>(width - row.length).fill(""),
    ]),
    totalRows,
    truncatedRows: totalRows > MAX_SHEET_ROWS,
    truncatedColumns,
  };
}

export function convertXlsx(zip: ZipArchive): OfficeDocumentPreview {
  const { path: workbookPath, xml: workbook } = readMainPart(
    zip,
    "xl/workbook.xml",
    "workbook",
  );
  const rels = readRelationships(zip, workbookPath);
  const shared = readSharedStrings(zip);
  const sheets: OfficeSheetPreview[] = [];
  const sheetTags = emptyElements(workbook, "sheet");
  for (const attrs of sheetTags.slice(0, MAX_SHEETS)) {
    const name = attr(attrs, "name") ?? `Sheet ${sheets.length + 1}`;
    const id = relId(attrs);
    const part = id ? rels.get(id) : undefined;
    const xml = part ? zip.readText(part) : undefined;
    if (xml === undefined) continue;
    sheets.push(parseSheet(xml, name, shared));
  }
  return {
    format: "xlsx",
    sheets,
    truncatedSheets: sheetTags.length > MAX_SHEETS,
  };
}

// ---------------------------------------------------------------------------
// pptx
// ---------------------------------------------------------------------------

export function convertPptx(zip: ZipArchive): OfficeDocumentPreview {
  const { path: presentationPath, xml: presentation } = readMainPart(
    zip,
    "ppt/presentation.xml",
    "presentation",
  );
  const rels = readRelationships(zip, presentationPath);
  const slideIds = emptyElements(presentation, "sldId");
  const slides: OfficeSlidePreview[] = [];
  for (const attrs of slideIds.slice(0, MAX_SLIDES)) {
    const id = relId(attrs);
    const part = id ? rels.get(id) : undefined;
    const xml = part ? zip.readText(part) : undefined;
    if (xml === undefined) continue;
    const paragraphs = elements(xml, "p")
      .map((match) => collectText(match[2] ?? "", "t").trim())
      .filter(Boolean);
    slides.push({ paragraphs });
  }
  return {
    format: "pptx",
    slides,
    truncated: slideIds.length > MAX_SLIDES,
  };
}

// ---------------------------------------------------------------------------

const CONVERTERS: Record<string, (zip: ZipArchive) => OfficeDocumentPreview> = {
  docx: convertDocx,
  docm: convertDocx,
  xlsx: convertXlsx,
  xlsm: convertXlsx,
  pptx: convertPptx,
  pptm: convertPptx,
};

export function isConvertibleOfficeExtension(ext: string): boolean {
  return ext in CONVERTERS;
}

/** Convert an OOXML file's bytes to a preview, by file extension. */
export function convertOfficeDocument(
  buffer: Buffer,
  ext: string,
): OfficeDocumentPreview {
  const convert = CONVERTERS[ext];
  if (!convert) throw new OfficePreviewError("Unsupported document type");
  return convert(new ZipArchive(buffer));
}
