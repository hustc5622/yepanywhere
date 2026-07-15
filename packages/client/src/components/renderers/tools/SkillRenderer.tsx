import type { ToolRenderer } from "./types";

interface SkillInput {
  name?: string;
}

function decodeSkillContent(result: unknown): string {
  if (typeof result !== "string") return "";

  let content = result.trim();
  if (content.startsWith('"') && content.endsWith('"')) {
    try {
      const decoded = JSON.parse(content);
      if (typeof decoded === "string") content = decoded;
    } catch {
      // Keep the original result if it was not actually JSON encoded.
    }
  }

  return content
    .replace(/^<skill_content\b[^>]*>\s*/i, "")
    .replace(/\s*<\/skill_content>\s*$/i, "")
    .trim();
}

export const skillRenderer: ToolRenderer<SkillInput, unknown> = {
  tool: "Skill",
  displayName: "Skill",
  renderToolUse(input) {
    return (
      <div className="skill-tool-name">{input.name || "Loading skill"}</div>
    );
  },
  renderToolResult(result, isError, _context, input) {
    const content = decodeSkillContent(result);
    const statusLabel = isError ? "Failed skill" : "Loaded skill";
    const detailsLabel = isError ? "Error details" : "Instructions";
    return (
      <div
        className={`skill-tool-details ${isError ? "skill-tool-error" : ""}`}
      >
        <div className="skill-tool-heading">
          <span className="skill-tool-label">{statusLabel}</span>
          <span className="skill-tool-name">{input?.name || "Skill"}</span>
        </div>
        {content && (
          <details className="skill-tool-instructions">
            <summary>{detailsLabel}</summary>
            <pre className="skill-tool-content">{content}</pre>
          </details>
        )}
      </div>
    );
  },
  getUseSummary(input) {
    return input.name || "Loading skill";
  },
  getResultSummary(_result, isError, input) {
    if (isError) return "failed";
    return input?.name ? "" : "loaded";
  },
};
