import { stat } from "node:fs/promises";
import {
  SESSION_TITLE_MAX_LENGTH,
  parseCodexSessionEntry,
} from "@yep-anywhere/shared";
import { iterateCodexRolloutLines } from "./codex-rollout-file.js";
import { isSyntheticUserPromptText } from "./user-prompt-classification.js";

interface CodexSessionTitle {
  title: string;
  fullTitle: string;
}

/** Read just the first real prompt, never scan an entire transcript for a title. */
export class CodexSessionTitleReader {
  private readonly cache = new Map<
    string,
    { revision: string; result: Promise<CodexSessionTitle | null> }
  >();

  async read(filePath: string): Promise<CodexSessionTitle | null> {
    const stats = await stat(filePath).catch(() => null);
    if (!stats?.isFile()) return null;
    const revision = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
    const cached = this.cache.get(filePath);
    if (cached?.revision === revision) return cached.result;
    const result = this.readPrompt(filePath).catch(() => null);
    this.cache.delete(filePath);
    this.cache.set(filePath, { revision, result });
    if (this.cache.size > 512) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    return result;
  }

  private async readPrompt(
    filePath: string,
  ): Promise<CodexSessionTitle | null> {
    for await (const { line } of iterateCodexRolloutLines(filePath, {
      maxBytes: 8 * 1024 * 1024,
      maxLineBytes: 8 * 1024 * 1024,
    })) {
      const entry = parseCodexSessionEntry(line);
      if (!entry) continue;
      let prompt = "";
      if (entry.type === "event_msg" && entry.payload.type === "user_message") {
        prompt = entry.payload.message;
      } else if (
        entry.type === "response_item" &&
        entry.payload.type === "message" &&
        entry.payload.role === "user"
      ) {
        prompt = entry.payload.content
          .map((block) =>
            block.type === "input_text"
              ? block.text
              : block.type === "input_image"
                ? "[image]"
                : block.type === "input_audio"
                  ? "[audio]"
                  : "",
          )
          .filter(Boolean)
          .join("\n");
      }
      const fullTitle = prompt.trim();
      if (!fullTitle || isSyntheticUserPromptText(fullTitle)) continue;
      return {
        title:
          fullTitle.length <= SESSION_TITLE_MAX_LENGTH
            ? fullTitle
            : `${fullTitle.slice(0, SESSION_TITLE_MAX_LENGTH - 3)}...`,
        fullTitle,
      };
    }
    return null;
  }
}
