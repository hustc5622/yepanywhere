import type {
  OfficeDocumentPreview,
  OfficeSheetPreview,
} from "@yep-anywhere/shared";
import { useState } from "react";
import { useI18n } from "../i18n";

/** Spreadsheet column label: 0 → A, 26 → AA. */
function columnLabel(index: number): string {
  let label = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function SheetTable({ sheet }: { sheet: OfficeSheetPreview }) {
  const { t } = useI18n();
  const width = sheet.rows[0]?.length ?? 0;
  if (sheet.rows.length === 0) {
    return (
      <div className="file-viewer-office-empty">
        {t("fileViewerSheetEmpty" as never)}
      </div>
    );
  }
  return (
    <div className="file-viewer-table">
      <table>
        <thead>
          <tr>
            <th aria-hidden="true" />
            {Array.from({ length: width }, (_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
              <th key={index}>{columnLabel(index)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, rowIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <tr key={rowIndex}>
              <th scope="row">{rowIndex + 1}</th>
              {row.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <td key={index}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(sheet.truncatedRows || sheet.truncatedColumns) && (
        <div className="file-viewer-truncated">
          {t("fileViewerSheetTruncated" as never, {
            rows: sheet.rows.length,
            total: sheet.totalRows,
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Text extracted on the server from docx / xlsx / pptx. A quick-read view,
 * not a faithful rendering: styles, images and charts are not included.
 */
export function OfficeView({ document }: { document: OfficeDocumentPreview }) {
  const { t } = useI18n();
  const [sheetIndex, setSheetIndex] = useState(0);
  const notice = (
    <div className="file-content-range-notice">
      {t("fileViewerOfficeNotice" as never)}
    </div>
  );

  if (document.format === "docx") {
    return (
      <>
        {notice}
        <div className="markdown-preview">
          <div
            className="markdown-rendered"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: built server-side from escaped text and a fixed tag set
            dangerouslySetInnerHTML={{ __html: document.html }}
          />
          {document.truncated && (
            <div className="file-viewer-truncated">
              {t("fileViewerDocumentTruncated" as never)}
            </div>
          )}
        </div>
      </>
    );
  }

  if (document.format === "xlsx") {
    const sheet = document.sheets[sheetIndex] ?? document.sheets[0];
    return (
      <>
        {notice}
        {document.sheets.length > 1 && (
          <div className="markdown-view-toggle file-viewer-sheet-tabs">
            {document.sheets.map((item, index) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: sheet names may repeat
                key={index}
                type="button"
                className={`toggle-btn ${index === sheetIndex ? "active" : ""}`}
                onClick={() => setSheetIndex(index)}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
        {sheet ? (
          <SheetTable sheet={sheet} />
        ) : (
          <div className="file-viewer-office-empty">
            {t("fileViewerSheetEmpty" as never)}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {notice}
      <div className="markdown-preview">
        <div className="markdown-rendered file-viewer-slides">
          {document.slides.map((slide, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: slides are positional
            <section key={index} className="file-viewer-slide">
              <h3>
                {t("fileViewerSlide" as never, { number: index + 1 })}
                {slide.paragraphs[0] ? ` · ${slide.paragraphs[0]}` : ""}
              </h3>
              {slide.paragraphs.slice(1).map((paragraph, lineIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional
                <p key={lineIndex}>{paragraph}</p>
              ))}
            </section>
          ))}
          {document.truncated && (
            <div className="file-viewer-truncated">
              {t("fileViewerDocumentTruncated" as never)}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
