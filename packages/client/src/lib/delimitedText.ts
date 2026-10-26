/**
 * RFC 4180-style parser for CSV/TSV previews: quoted fields, escaped quotes
 * and newlines inside quotes. Stops after `maxRows` rows.
 */
export interface DelimitedTable {
  rows: string[][];
  truncated: boolean;
}

export function delimiterForPath(path: string): "," | "\t" | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "csv") return ",";
  if (ext === "tsv") return "\t";
  return null;
}

export function parseDelimitedText(
  text: string,
  delimiter: "," | "\t",
  maxRows = 1000,
): DelimitedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  while (i < text.length) {
    const char = text[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += char;
    } else if (char === '"' && field === "") {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushRow();
      if (rows.length >= maxRows) {
        return { rows, truncated: i + 1 < text.length };
      }
    } else field += char;
    i++;
  }
  if (field !== "" || row.length > 0) pushRow();
  return { rows, truncated: false };
}
