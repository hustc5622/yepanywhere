import { basename } from "node:path";
import type { GeneratedArtifactBlockReason } from "@yep-anywhere/shared";
import { getMessageContent } from "../../augments/index.js";
import { serializeCodexPayload } from "../../codex-events/payload.js";
import {
  CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE,
  type CodexNativeThreadItemType,
} from "../../codex-events/types.js";
import type { FeishuGeneratedImageBlockReason } from "./generated-artifact.js";

export type FeishuCardProjectionMode = "rich" | "compact" | "plain";

export interface FeishuPlanStepProjection {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface FeishuToolProjection {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
}

export interface FeishuDiffProjection {
  id: string;
  files: string[];
  additions: number;
  deletions: number;
  status: "running" | "completed" | "failed";
}

export interface FeishuSubagentProjection {
  id: string;
  status: "running" | "completed" | "failed";
}

export interface FeishuActivityProjection {
  id: string;
  label: string;
  status: "running" | "completed" | "failed";
}

export interface FeishuRichCardSnapshot {
  planExplanation?: string;
  planStatus?: "running" | "completed" | "failed";
  plan: FeishuPlanStepProjection[];
  commentary: string[];
  finalAnswer?: string;
  reasoningActive: boolean;
  reasoningSummaries: string[];
  tools: FeishuToolProjection[];
  diffs: FeishuDiffProjection[];
  subagents: FeishuSubagentProjection[];
  activities: FeishuActivityProjection[];
  warnings: string[];
  artifacts: string[];
  details: string[];
}

export interface FeishuRichCardSections {
  status: string;
  progress: string;
  tools: string;
  artifacts: string;
  answer: string;
}

export interface FeishuRichCardStreamRow {
  /** Internal-only stable identity; never rendered or sent to Feishu. */
  key: string;
  content: string;
}

const MAX_PLAN_STEPS = 20;
const MAX_COMMENTARY_ITEMS = 4;
const MAX_REASONING_ITEMS = 4;
const MAX_TOOL_ITEMS = 24;
const MAX_DIFF_ITEMS = 12;
const MAX_SUBAGENT_ITEMS = 16;
const MAX_ACTIVITY_ITEMS = 16;
const MAX_WARNING_ITEMS = 6;
const MAX_ARTIFACT_ITEMS = 12;
const MAX_DIFF_CHANGES = 24;
const MAX_DIFF_SCAN_CHARS = 64_000;
const MAX_FINAL_ANSWER_CHARS = 28_000;
const MAX_STREAM_TOOL_ROWS = 8;
const MAX_STREAM_DIFF_ROWS = 3;
const MAX_STREAM_SUBAGENT_ROWS = 3;
const MAX_STREAM_ACTIVITY_ROWS = 2;
const MAX_STREAM_PLAN_ROWS = 6;
const MAX_STREAM_COMMENTARY_ROWS = 4;
const MAX_STREAM_REASONING_ROWS = 4;
const MAX_STREAM_PROGRESS_ROWS = 16;

/**
 * Bounded plaintext projection of provider messages for the private instance.
 * HTML/control safety and card size limits are independent of content masking.
 */
export class FeishuRichCardProjection {
  private planExplanation?: string;
  private planStatus?: FeishuRichCardSnapshot["planStatus"];
  private plan: FeishuPlanStepProjection[] = [];
  private readonly commentaryById = new Map<string, string>();
  private finalAnswer?: string;
  private finalAnswerId?: string;
  private finalAnswerStatus?: FeishuToolProjection["status"];
  private legacyReasoningActive = false;
  private readonly reasoningById = new Map<
    string,
    { status: FeishuToolProjection["status"]; summary?: string }
  >();
  private readonly tools = new Map<string, FeishuToolProjection>();
  private readonly diffs = new Map<string, FeishuDiffProjection>();
  private readonly subagents = new Map<string, FeishuSubagentProjection>();
  private readonly activities = new Map<string, FeishuActivityProjection>();
  private readonly warnings = new Set<string>();
  private readonly artifacts = new Set<string>();
  private readonly detailsById = new Map<string, string>();

  observe(message: Record<string, unknown>): void {
    this.observeSubagent(message);
    // Root cards show subagent lifecycle only. Their private transcript stays
    // in the child thread even when it carries a canonical agentMessage.
    if (message.isSubagent === true) return;
    this.observeSystemMessage(message);

    // Canonical app-server ThreadItems are authoritative in provider-primary
    // mode. Do not also consume the attached legacy blocks: that would count
    // the same command/file/tool lifecycle twice and could re-expose fields
    // intentionally omitted by this projection.
    if (this.observeCanonicalThreadItem(message)) return;

    const blocks = getMessageContent(message) ?? [];
    for (const rawBlock of blocks) {
      const block = objectValue(rawBlock);
      if (!block) continue;
      if (block.type === "thinking") {
        // Show provider-supplied reasoning in the private instance.
        this.legacyReasoningActive = true;
        const text = stringValue(block.thinking);
        if (text)
          setBoundedMap(
            this.reasoningById,
            stringValue(message.uuid) ?? "legacy-reasoning",
            { status: "running", summary: safeVisibleText(text, 1_200) },
            MAX_REASONING_ITEMS,
          );
      } else if (block.type === "tool_use") {
        this.observeToolUse(message, block);
      } else if (block.type === "tool_result") {
        this.observeToolResult(block);
      }
    }

    if (message.codexMessagePhase === "commentary") {
      const text = visibleAssistantText(message);
      if (text) {
        const id =
          stringValue(message.uuid) ?? `commentary-${this.commentaryById.size}`;
        setBoundedMap(
          this.commentaryById,
          id,
          safeVisibleText(text, 800),
          MAX_COMMENTARY_ITEMS,
        );
      }
    }
  }

  recordGeneratedImage(fileName: string, sizeBytes: number): void {
    this.recordGeneratedArtifact(fileName, sizeBytes);
  }

  recordGeneratedArtifact(fileName: string, sizeBytes: number): void {
    const sizeKiB = Math.max(1, Math.ceil(sizeBytes / 1024));
    addBoundedSet(
      this.artifacts,
      `${safeLine(fileName, 100)} · ${sizeKiB} KiB · Codex 生成 · 飞书托管`,
      MAX_ARTIFACT_ITEMS,
    );
  }

  recordGeneratedImageFailure(
    reason:
      | FeishuGeneratedImageBlockReason
      | "transport_unavailable"
      | "upload_failed",
    error?: unknown,
  ): void {
    this.recordGeneratedArtifactFailure(reason, error);
  }

  recordGeneratedArtifactFailure(
    reason:
      | FeishuGeneratedImageBlockReason
      | GeneratedArtifactBlockReason
      | "managed_read_failed"
      | "transport_unavailable"
      | "upload_failed",
    error?: unknown,
  ): void {
    const warning =
      reason === "sensitive_prompt" || reason === "sensitive_content"
        ? "生成物可能包含敏感内容，未自动上传到飞书。"
        : reason === "size_limit"
          ? "生成物超过安全上传上限，未自动上传。"
          : reason === "count_limit"
            ? "本次任务生成物数量超过安全上限，超出部分未自动上传。"
            : reason === "high_risk_archive"
              ? "压缩生成物未通过安全检查，未自动上传。"
              : reason === "unsupported_format" || reason === "mime_mismatch"
                ? "生成物格式未经安全验证，未自动上传。"
                : reason === "scope_mismatch" ||
                    reason === "outside_workspace" ||
                    reason === "not_regular_file" ||
                    reason === "symlink" ||
                    reason === "changed_during_read"
                  ? "生成物未通过工作区安全校验，未自动上传。"
                  : reason === "storage_failed" ||
                      reason === "managed_read_failed"
                    ? "生成物的 Yep 受控副本不可用，未上传到飞书。"
                    : reason === "transport_unavailable"
                      ? "当前飞书连接不支持此生成物上传，请在 Yep 中查看。"
                      : reason === "upload_failed"
                        ? "生成物上传飞书失败，请在 Yep 中查看。"
                        : "生成物载荷无效，未自动上传到飞书。";
    const detail =
      error instanceof Error
        ? error.message
        : error == null
          ? ""
          : String(error);
    this.addWarning(detail ? `${warning} ${detail}` : warning);
  }

  /**
   * A turn terminal is authoritative that no projected activity is still
   * running, even when Codex delivers an item/completed notification after
   * turn/completed. Keep the final card honest instead of leaving hourglasses.
   */
  settleRunning(status: "completed" | "failed"): void {
    if (this.planStatus === "running") this.planStatus = status;
    this.legacyReasoningActive = false;
    for (const [id, reasoning] of this.reasoningById) {
      if (reasoning.status === "running") {
        this.reasoningById.set(id, { ...reasoning, status });
      }
    }
    for (const [id, tool] of this.tools) {
      if (tool.status === "running") this.tools.set(id, { ...tool, status });
    }
    for (const [id, diff] of this.diffs) {
      if (diff.status === "running") this.diffs.set(id, { ...diff, status });
    }
    for (const [id, subagent] of this.subagents) {
      if (subagent.status === "running") {
        this.subagents.set(id, { ...subagent, status });
      }
    }
    for (const [id, activity] of this.activities) {
      if (activity.status === "running") {
        this.activities.set(id, { ...activity, status });
      }
    }
  }

  snapshot(): FeishuRichCardSnapshot {
    return {
      ...(this.planExplanation
        ? { planExplanation: this.planExplanation }
        : {}),
      ...(this.planStatus ? { planStatus: this.planStatus } : {}),
      plan: this.plan.map((step) => ({ ...step })),
      commentary: [...this.commentaryById.values()],
      ...(this.finalAnswer ? { finalAnswer: this.finalAnswer } : {}),
      reasoningActive:
        this.legacyReasoningActive ||
        [...this.reasoningById.values()].some(
          (reasoning) => reasoning.status === "running",
        ),
      reasoningSummaries: [...this.reasoningById.values()].flatMap(
        (reasoning) => (reasoning.summary ? [reasoning.summary] : []),
      ),
      tools: [...this.tools.values()].map((tool) => ({ ...tool })),
      diffs: [...this.diffs.values()].map((diff) => ({
        ...diff,
        files: [...diff.files],
      })),
      subagents: [...this.subagents.values()].map((agent) => ({ ...agent })),
      activities: [...this.activities.values()].map((activity) => ({
        ...activity,
      })),
      warnings: [...this.warnings],
      artifacts: [...this.artifacts],
      details: [...this.detailsById.values()],
    };
  }

  render(
    status: string,
    answer: string,
    mode: FeishuCardProjectionMode,
  ): string {
    const snapshot = this.snapshot();
    const providedAnswer = answer.trim();
    const visibleAnswer =
      (providedAnswer
        ? safeVisibleText(answer, MAX_FINAL_ANSWER_CHARS)
        : snapshot.finalAnswer) ?? "";
    const renderedAnswer = escapeUnsafeCardMarkup(visibleAnswer);
    if (mode === "plain") {
      return renderedAnswer.trim()
        ? `**${safeLine(status, 160)}**\n\n${renderedAnswer}`
        : `**${safeLine(status, 160)}**`;
    }
    const sections = [`**${safeLine(status, 160)}**`];

    if (mode === "compact") {
      const completed = snapshot.plan.filter(
        (step) => step.status === "completed",
      ).length;
      const runningTools = snapshot.tools.filter(
        (tool) => tool.status === "running",
      );
      const facts = [
        ...(snapshot.plan.length > 0
          ? [`计划：${completed}/${snapshot.plan.length}`]
          : []),
        ...(runningTools.length > 0
          ? [`工具：${runningTools.map((tool) => tool.name).join("、")}`]
          : []),
        ...(snapshot.subagents.length > 0
          ? [`子代理：${snapshot.subagents.length}`]
          : []),
        ...(snapshot.activities.some(
          (activity) => activity.status === "running",
        )
          ? [
              `状态：${snapshot.activities
                .filter((activity) => activity.status === "running")
                .slice(-3)
                .map((activity) => activity.label)
                .join("、")}`,
            ]
          : []),
      ];
      if (facts.length > 0) sections.push(facts.join(" · "));
      if (snapshot.warnings.length > 0) {
        sections.push(`⚠️ ${snapshot.warnings.at(-1)}`);
      }
      if (renderedAnswer.trim()) sections.push(renderedAnswer);
      return sections.join("\n\n---\n\n");
    }

    return Object.values(this.renderSections(status, answer))
      .filter((section) => section.trim())
      .join("\n\n---\n\n");
  }

  /**
   * Stable CardKit regions. The status line may change frequently, progress
   * grows append-only, and tool lifecycle rewrites stay confined to the tool
   * region instead of replaying the entire card animation.
   */
  renderSections(status: string, answer: string): FeishuRichCardSections {
    const snapshot = this.snapshot();
    const providedAnswer = answer.trim();
    const visibleAnswer =
      (providedAnswer
        ? safeVisibleText(answer, MAX_FINAL_ANSWER_CHARS)
        : snapshot.finalAnswer) ?? "";
    const renderedAnswer = escapeUnsafeCardMarkup(visibleAnswer);
    const progress: string[] = [];
    const tools: string[] = [];
    const artifacts: string[] = [];
    if (snapshot.details.length > 0) {
      tools.push(
        [
          "### 详情",
          ...snapshot.details.map((detail) => escapeUnsafeCardMarkup(detail)),
        ].join("\n\n"),
      );
    }

    if (snapshot.plan.length > 0 || snapshot.planExplanation) {
      const planLines = snapshot.plan.map(
        (step) => `${planIcon(step.status)} ${escapeLine(step.step)}`,
      );
      progress.push(
        [
          "### 计划",
          ...(snapshot.planExplanation
            ? [escapeLine(snapshot.planExplanation)]
            : []),
          ...planLines,
          ...(snapshot.planStatus
            ? [
                `${toolIcon(snapshot.planStatus)} 计划 · ${toolStatusLabel(snapshot.planStatus)}`,
              ]
            : []),
        ].join("\n"),
      );
    }
    if (
      snapshot.commentary.length > 0 ||
      snapshot.reasoningSummaries.length > 0 ||
      snapshot.reasoningActive
    ) {
      progress.push(
        [
          "### 进展",
          ...snapshot.commentary.map((text) => escapeUnsafeCardMarkup(text)),
          ...snapshot.reasoningSummaries.map(
            (summary) => `推理摘要：${escapeUnsafeCardMarkup(summary)}`,
          ),
          ...(snapshot.reasoningActive ? ["Codex 正在推理。"] : []),
        ].join("\n\n"),
      );
    }
    if (snapshot.tools.length > 0) {
      tools.push(
        [
          "### 工具",
          ...snapshot.tools
            .slice(-8)
            .map(
              (tool) =>
                `${toolIcon(tool.status)} ${escapeLine(tool.name)} · ${toolStatusLabel(tool.status)}`,
            ),
        ].join("\n"),
      );
    }
    if (snapshot.diffs.length > 0) {
      tools.push(
        [
          "### 文件变更",
          ...snapshot.diffs.slice(-6).map((diff) => {
            const stats = `+${diff.additions} / -${diff.deletions}`;
            return `${toolIcon(diff.status)} ${diff.files.map(escapeLine).join("、") || "文件"} · ${stats} · ${toolStatusLabel(diff.status)}`;
          }),
        ].join("\n"),
      );
    }
    if (snapshot.subagents.length > 0) {
      tools.push(
        [
          "### 子代理",
          ...snapshot.subagents
            .slice(-8)
            .map(
              (agent) =>
                `${toolIcon(agent.status)} ${escapeLine(agent.id)} · ${toolStatusLabel(agent.status)}`,
            ),
        ].join("\n"),
      );
    }
    if (snapshot.activities.length > 0) {
      tools.push(
        [
          "### 状态",
          ...snapshot.activities
            .slice(-10)
            .map(
              (activity) =>
                `${toolIcon(activity.status)} ${escapeLine(activity.label)} · ${toolStatusLabel(activity.status)}`,
            ),
        ].join("\n"),
      );
    }
    if (snapshot.artifacts.length > 0) {
      artifacts.push(
        [
          "### 生成物",
          ...snapshot.artifacts
            .slice(-6)
            .map((name) => `📎 ${escapeLine(name)}`),
        ].join("\n"),
      );
    }
    if (snapshot.warnings.length > 0) {
      artifacts.push(
        [
          "### 提示",
          ...snapshot.warnings.map((warning) => `⚠️ ${escapeLine(warning)}`),
        ].join("\n"),
      );
    }
    return {
      status: `**${safeLine(status, 160)}**`,
      progress: progress.join("\n\n---\n\n"),
      tools: tools.join("\n\n---\n\n"),
      artifacts: artifacts.join("\n\n---\n\n"),
      answer: renderedAnswer.trim() ? `### 回复\n\n${renderedAnswer}` : "",
    };
  }

  /** Stable rows for plan/commentary/reasoning progress. */
  renderStreamingProgressRows(): FeishuRichCardStreamRow[] {
    const plan = this.plan.slice(-MAX_STREAM_PLAN_ROWS);
    const planOffset = this.plan.length - plan.length;
    return [
      ...(this.planExplanation
        ? [
            {
              key: "plan:explanation",
              content: `${toolIcon(this.planStatus ?? "running")} 计划 · ${escapeLine(this.planExplanation)}`,
            },
          ]
        : []),
      ...plan.map((step, index) => ({
        key: `plan:${planOffset + index}`,
        content: `${planIcon(step.status)} ${escapeLine(step.step)}`,
      })),
      ...[...this.commentaryById.entries()]
        .slice(-MAX_STREAM_COMMENTARY_ROWS)
        .map(([id, text]) => ({
          key: `commentary:${id}`,
          content: escapeUnsafeCardMarkup(text),
        })),
      ...[...this.reasoningById.entries()]
        .slice(-MAX_STREAM_REASONING_ROWS)
        .map(([id, reasoning]) => ({
          key: `reasoning:${id}`,
          content: reasoning.summary
            ? `推理摘要：${escapeUnsafeCardMarkup(reasoning.summary)}`
            : reasoning.status === "running"
              ? "Codex 正在推理。"
              : `推理 · ${toolStatusLabel(reasoning.status)}`,
        })),
      ...(this.legacyReasoningActive
        ? [
            {
              key: "reasoning:legacy",
              content: "Codex 正在推理。",
            },
          ]
        : []),
    ].slice(0, MAX_STREAM_PROGRESS_ROWS);
  }

  /**
   * Stable, bounded rows for CardKit's preallocated activity elements. A new
   * tool fills a new row; completing it rewrites only that row instead of
   * replaying the cumulative tool transcript.
   */
  renderStreamingActivityRows(): FeishuRichCardStreamRow[] {
    const snapshot = this.snapshot();
    return [
      ...snapshot.tools.slice(-MAX_STREAM_TOOL_ROWS).map((tool) => ({
        key: `tool:${tool.id}`,
        content: `${toolIcon(tool.status)} ${escapeLine(tool.name)} · ${toolStatusLabel(tool.status)}${this.renderItemDetail(tool.id)}`,
      })),
      ...snapshot.diffs.slice(-MAX_STREAM_DIFF_ROWS).map((diff) => ({
        key: `diff:${diff.id}`,
        content: `${toolIcon(diff.status)} 文件变更 · ${diff.files.map(escapeLine).join("、") || "文件"} · +${diff.additions} / -${diff.deletions} · ${toolStatusLabel(diff.status)}${this.renderItemDetail(diff.id)}`,
      })),
      ...snapshot.subagents
        .slice(-MAX_STREAM_SUBAGENT_ROWS)
        .map((agent, index) => ({
          key: `subagent:${index}:${agent.id}`,
          content: `${toolIcon(agent.status)} ${escapeLine(agent.id)} · ${toolStatusLabel(agent.status)}`,
        })),
      ...snapshot.activities
        .slice(-MAX_STREAM_ACTIVITY_ROWS)
        .map((activity) => ({
          key: `activity:${activity.id}`,
          content: `${toolIcon(activity.status)} ${escapeLine(activity.label)} · ${toolStatusLabel(activity.status)}${this.renderItemDetail(activity.id)}`,
        })),
    ];
  }

  /**
   * Project the authoritative app-server item attached by the Codex provider.
   * Returning true tells the caller not to inspect the lossy legacy adapter on
   * the same SDK message.
   */
  private renderItemDetail(id: string): string {
    const detail = this.detailsById.get(id);
    return detail ? `\n${escapeUnsafeCardMarkup(detail)}` : "";
  }

  private observeCanonicalThreadItem(
    message: Record<string, unknown>,
  ): boolean {
    const rawItem = message.codexThreadItem;
    if (rawItem === undefined && message.subtype !== "codex_native_item") {
      return false;
    }

    const item = objectValue(rawItem);
    if (!item) {
      this.addWarning("Codex 原生项目缺少结构化内容；已隐藏详情以保持兼容。");
      return true;
    }
    const nativeType = stringValue(item.type);
    if (!nativeType || !isCodexNativeThreadItemType(nativeType)) {
      const safeType = nativeType ? safeLine(nativeType, 80) : "unknown";
      this.addWarning(
        `Codex 发送了暂不支持的原生项目（${safeType}）：${safeVisibleText(JSON.stringify(item), 1_200)}`,
      );
      return true;
    }

    const id = canonicalItemId(item, message, nativeType);
    const status = canonicalProjectionStatus(
      item,
      message.codexThreadItemLifecycle,
    );

    if (!["agentMessage", "reasoning", "plan"].includes(nativeType)) {
      const data = serializeCodexPayload("feishu/detail", item, {
        maxDepth: 6,
        maxArrayItems: 12,
        maxObjectEntries: 24,
        maxStringLength: 800,
      }).data;
      setBoundedMap(
        this.detailsById,
        id,
        safeVisibleText(JSON.stringify(data, null, 2), 1_200),
        8,
      );
    }

    // This switch intentionally covers the generated ThreadItem union. A new
    // upstream variant is a compile-time error until its Feishu policy is
    // explicitly audited.
    switch (nativeType) {
      case "userMessage":
        this.setActivity(id, "用户输入", status);
        return true;
      case "hookPrompt":
        this.setActivity(id, "Hook 上下文", status);
        return true;
      case "agentMessage":
        this.observeCanonicalAgentMessage(id, item, status);
        return true;
      case "plan": {
        const text = stringValue(item.text);
        if (text) this.planExplanation = safeVisibleText(text, 1_200);
        this.planStatus = mergeProjectionStatus(this.planStatus, status);
        return true;
      }
      case "reasoning": {
        const summary = [
          ...safeStringList(item.summary, 4),
          ...safeStringList(item.content, 4),
        ]
          .map((part) => safeVisibleText(part, 600))
          .filter(Boolean)
          .join("\n");
        // Both provider summaries and supplied reasoning text stay visible.
        setBoundedMap(
          this.reasoningById,
          id,
          {
            status: mergeProjectionStatus(
              this.reasoningById.get(id)?.status,
              status,
            ),
            ...(summary ? { summary: clip(summary, 1_200) } : {}),
          },
          MAX_REASONING_ITEMS,
        );
        return true;
      }
      case "commandExecution":
        this.setTool(id, "Command execution", status);
        return true;
      case "fileChange": {
        const diff = canonicalDiffProjection(id, item.changes, status);
        if (diff) {
          this.activities.delete(id);
          setBoundedMap(
            this.diffs,
            id,
            {
              ...diff,
              status: mergeProjectionStatus(
                this.diffs.get(id)?.status,
                diff.status,
              ),
            },
            MAX_DIFF_ITEMS,
          );
        } else if (this.diffs.has(id)) {
          const current = this.diffs.get(id);
          if (current) {
            setBoundedMap(
              this.diffs,
              id,
              {
                ...current,
                status: mergeProjectionStatus(current.status, status),
              },
              MAX_DIFF_ITEMS,
            );
          }
        } else {
          this.setActivity(id, "文件变更", status);
        }
        return true;
      }
      case "mcpToolCall": {
        const server = safeIdentifier(item.server, 32);
        const tool = safeIdentifier(item.tool, 48);
        const name =
          server || tool
            ? `MCP · ${[server, tool].filter(Boolean).join("/")}`
            : "MCP tool";
        this.setTool(id, name, status);
        return true;
      }
      case "dynamicToolCall": {
        const namespace = safeIdentifier(item.namespace, 32);
        const tool = safeIdentifier(item.tool, 48);
        const name =
          namespace || tool
            ? `Dynamic tool · ${[namespace, tool].filter(Boolean).join("/")}`
            : "Dynamic tool";
        this.setTool(id, name, status);
        return true;
      }
      case "collabAgentToolCall": {
        const tool = safeIdentifier(item.tool, 40) ?? "collaboration";
        this.setSubagent(id, `子代理 · ${tool}`, status);
        return true;
      }
      case "subAgentActivity": {
        const kind = subagentActivityLabel(item.kind);
        this.setSubagent(
          id,
          `子代理活动 · ${kind}`,
          item.kind === "interrupted" ? "failed" : status,
        );
        return true;
      }
      case "webSearch":
        this.setTool(id, "Web search", status);
        return true;
      case "imageView":
        this.setTool(id, "Image view", status);
        return true;
      case "sleep": {
        const duration = safeDurationLabel(item.durationMs);
        this.setActivity(id, duration ? `等待 ${duration}` : "等待", status);
        return true;
      }
      case "imageGeneration":
        // Image bytes still go through the separate artifact upload pipeline.
        this.setTool(id, "Image generation", status);
        return true;
      case "enteredReviewMode":
        this.setActivity(id, "进入 Review 模式", status);
        return true;
      case "exitedReviewMode":
        this.setActivity(id, "退出 Review 模式", status);
        return true;
      case "contextCompaction":
        this.setActivity(id, "上下文压缩", status);
        return true;
      default: {
        const exhaustive: never = nativeType;
        return exhaustive;
      }
    }
  }

  private observeCanonicalAgentMessage(
    id: string,
    item: Record<string, unknown>,
    status: FeishuToolProjection["status"],
  ): void {
    const text = stringValue(item.text);
    if (!text) return;
    const safeText = safeVisibleText(text, MAX_FINAL_ANSWER_CHARS);
    const phase = stringValue(item.phase);
    const commentary =
      phase === "commentary" ||
      (phase !== "final_answer" && status === "running");
    if (commentary) {
      setBoundedMap(
        this.commentaryById,
        id,
        clip(safeText, 800),
        MAX_COMMENTARY_ITEMS,
      );
      return;
    }
    this.commentaryById.delete(id);
    if (
      this.finalAnswerId === id &&
      this.finalAnswerStatus === "completed" &&
      status === "running"
    ) {
      return;
    }
    const previousStatus =
      this.finalAnswerId === id ? this.finalAnswerStatus : undefined;
    this.finalAnswer = safeText;
    this.finalAnswerId = id;
    this.finalAnswerStatus = mergeProjectionStatus(previousStatus, status);
  }

  private setTool(
    id: string,
    name: string,
    status: FeishuToolProjection["status"],
  ): void {
    setBoundedMap(
      this.tools,
      id,
      {
        id,
        name: safeLine(name, 80),
        status: mergeProjectionStatus(this.tools.get(id)?.status, status),
      },
      MAX_TOOL_ITEMS,
    );
  }

  private setSubagent(
    key: string,
    label: string,
    status: FeishuSubagentProjection["status"],
  ): void {
    setBoundedMap(
      this.subagents,
      key,
      {
        id: safeLine(label, 100),
        status: mergeProjectionStatus(this.subagents.get(key)?.status, status),
      },
      MAX_SUBAGENT_ITEMS,
    );
  }

  private setActivity(
    id: string,
    label: string,
    status: FeishuActivityProjection["status"],
  ): void {
    setBoundedMap(
      this.activities,
      id,
      {
        id,
        label: safeLine(label, 120),
        status: mergeProjectionStatus(this.activities.get(id)?.status, status),
      },
      MAX_ACTIVITY_ITEMS,
    );
  }

  private addWarning(warning: string): void {
    addBoundedSet(
      this.warnings,
      safeVisibleText(warning, 300),
      MAX_WARNING_ITEMS,
    );
  }

  private observeSystemMessage(message: Record<string, unknown>): void {
    if (message.type === "system" && message.subtype === "warning") {
      const canonicalError = objectValue(message.codexError);
      const warning =
        stringValue(canonicalError?.publicMessage) ??
        stringValue(message.warning) ??
        "Codex 报告了一条警告";
      this.addWarning(warning);
    }
    if (message.type === "system" && message.subtype === "todo_list") {
      const items = Array.isArray(message.items) ? message.items : [];
      const plan = items.slice(0, MAX_PLAN_STEPS).flatMap((item) => {
        const value = objectValue(item);
        const step = stringValue(value?.text) ?? stringValue(value?.step);
        if (!step) return [];
        return [
          {
            step: safeLine(step, 300),
            status: normalizePlanStatus(value?.status),
          },
        ];
      });
      if (plan.length > 0) {
        this.plan = plan;
        this.planStatus = planProjectionStatus(plan);
      }
    }
  }

  private observeSubagent(message: Record<string, unknown>): void {
    if (message.isSubagent !== true) return;
    const id =
      stringValue(message.agentId) ??
      stringValue(message.parentToolUseId) ??
      stringValue(message.uuid) ??
      "subagent";
    const terminal =
      message.type === "error" ||
      (message.type === "system" && message.subtype === "turn_complete");
    const failed =
      message.type === "error" || stringValue(message.turnStatus) === "failed";
    this.setSubagent(
      safeInternalId(id),
      "子代理",
      failed ? "failed" : terminal ? "completed" : "running",
    );
  }

  private observeToolUse(
    message: Record<string, unknown>,
    block: Record<string, unknown>,
  ): void {
    const name = safeToolName(block.name);
    if (!name) return;
    const id =
      stringValue(block.id) ??
      stringValue(message.uuid) ??
      `${name}-${this.tools.size}`;
    const input = objectValue(block.input);
    if (name === "UpdatePlan") {
      this.observePlan(input);
      return;
    }
    const status = normalizeToolStatus(block.status);
    const safeId = safeInternalId(id);
    this.setTool(safeId, name, status);

    if (["Edit", "Write", "ApplyPatch", "apply_patch"].includes(name)) {
      const diff = diffProjection(safeId, input, status);
      if (diff) setBoundedMap(this.diffs, safeId, diff, MAX_DIFF_ITEMS);
    }
    if (isSubagentTool(name)) {
      this.setSubagent(safeId, name, status);
    }
  }

  private observeToolResult(block: Record<string, unknown>): void {
    const id = stringValue(block.tool_use_id);
    if (!id) return;
    const safeId = safeInternalId(id);
    const current = this.tools.get(safeId);
    const status = block.is_error === true ? "failed" : "completed";
    if (current) {
      this.setTool(safeId, current.name, status);
    }
    const diff = this.diffs.get(safeId);
    if (diff) {
      setBoundedMap(
        this.diffs,
        safeId,
        { ...diff, status: mergeProjectionStatus(diff.status, status) },
        MAX_DIFF_ITEMS,
      );
    }
    const agent = this.subagents.get(safeId);
    if (agent) {
      this.setSubagent(safeId, agent.id, status);
    }
  }

  private observePlan(input: Record<string, unknown> | undefined): void {
    if (!input) return;
    const explanation = stringValue(input.explanation);
    this.planExplanation = explanation
      ? safeVisibleText(explanation, 500)
      : undefined;
    if (!Array.isArray(input.plan)) return;
    this.plan = input.plan.slice(0, MAX_PLAN_STEPS).flatMap((item) => {
      const value = objectValue(item);
      const step = stringValue(value?.step);
      if (!step) return [];
      return [
        {
          step: safeLine(step, 300),
          status: normalizePlanStatus(value?.status),
        },
      ];
    });
    this.planStatus = planProjectionStatus(this.plan);
  }
}

function diffProjection(
  id: string,
  input: Record<string, unknown> | undefined,
  status: FeishuDiffProjection["status"],
): FeishuDiffProjection | undefined {
  if (!input) return undefined;
  const files = new Set<string>();
  const directPath =
    stringValue(input.file_path) ??
    stringValue(input.path) ??
    stringValue(input.filePath);
  if (directPath) files.add(safeBasename(directPath));
  const changes = Array.isArray(input.changes)
    ? input.changes.slice(0, MAX_DIFF_CHANGES)
    : [];
  const rawDiffs: string[] = [];
  for (const change of changes) {
    const value = objectValue(change);
    const path =
      stringValue(value?.path) ??
      stringValue(value?.file_path) ??
      stringValue(value?.filePath);
    if (path) files.add(safeBasename(path));
    const diff = stringValue(value?.diff);
    if (diff) rawDiffs.push(diff.slice(0, MAX_DIFF_SCAN_CHARS));
  }
  const rawPatch = stringValue(input._rawPatch) ?? stringValue(input.patch);
  if (rawPatch) rawDiffs.push(rawPatch.slice(0, MAX_DIFF_SCAN_CHARS));
  for (const raw of rawDiffs) {
    for (const match of raw.matchAll(
      /(?:\*\*\* (?:Update|Add|Delete) File:|diff --git a\/\S+ b\/)([^\n]+)/g,
    )) {
      const path = match[1]?.trim().split(/\s+/).at(-1);
      if (path) files.add(safeBasename(path));
    }
  }
  const { additions, deletions } = diffStats(rawDiffs);
  if (files.size === 0 && rawDiffs.length === 0) return undefined;
  return {
    id,
    files: [...files].slice(0, 8),
    additions,
    deletions,
    status,
  };
}

function canonicalDiffProjection(
  id: string,
  rawChanges: unknown,
  status: FeishuDiffProjection["status"],
): FeishuDiffProjection | undefined {
  if (!Array.isArray(rawChanges)) return undefined;
  const files = new Set<string>();
  const diffs: string[] = [];
  for (const rawChange of rawChanges.slice(0, MAX_DIFF_CHANGES)) {
    const change = objectValue(rawChange);
    if (!change) continue;
    const path = stringValue(change.path);
    if (path) files.add(safeBasename(path));
    const diff = stringValue(change.diff);
    if (diff) diffs.push(diff.slice(0, MAX_DIFF_SCAN_CHARS));
  }
  if (files.size === 0 && diffs.length === 0) return undefined;
  const { additions, deletions } = diffStats(diffs);
  return {
    id,
    files: [...files].slice(0, 8),
    additions,
    deletions,
    status,
  };
}

function diffStats(diffs: readonly string[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const diff of diffs) {
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
  }
  return { additions, deletions };
}

function visibleAssistantText(
  message: Record<string, unknown>,
): string | undefined {
  const nested = objectValue(message.message);
  const content = nested?.content ?? message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const pieces = content.flatMap((item) => {
    const block = objectValue(item);
    return block?.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  return pieces.join("\n").trim() || undefined;
}

function normalizePlanStatus(
  value: unknown,
): FeishuPlanStepProjection["status"] {
  if (value === "completed") return "completed";
  if (value === "in_progress" || value === "inProgress") return "in_progress";
  return "pending";
}

function normalizeToolStatus(value: unknown): FeishuToolProjection["status"] {
  const normalized = stringValue(value)?.replace(/[_ -]/g, "").toLowerCase();
  if (
    normalized === "completed" ||
    normalized === "succeeded" ||
    normalized === "success" ||
    normalized === "done"
  ) {
    return "completed";
  }
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "declined" ||
    normalized === "interrupted" ||
    normalized === "cancelled" ||
    normalized === "canceled"
  ) {
    return "failed";
  }
  return "running";
}

function canonicalProjectionStatus(
  item: Record<string, unknown>,
  lifecycle: unknown,
): FeishuToolProjection["status"] {
  if (
    item.success === false ||
    (item.error !== null && item.error !== undefined)
  ) {
    return "failed";
  }
  const itemStatus = stringValue(item.status);
  if (itemStatus) {
    const normalized = normalizeToolStatus(itemStatus);
    if (normalized !== "running") return normalized;
  }
  return lifecycle === "completed" ? "completed" : "running";
}

function mergeProjectionStatus(
  current: FeishuToolProjection["status"] | undefined,
  next: FeishuToolProjection["status"],
): FeishuToolProjection["status"] {
  if (current === "failed" || next === "failed") return "failed";
  if (current === "completed" || next === "completed") return "completed";
  return "running";
}

function planProjectionStatus(
  plan: readonly FeishuPlanStepProjection[],
): FeishuToolProjection["status"] | undefined {
  if (plan.length === 0) return undefined;
  if (plan.every((step) => step.status === "completed")) return "completed";
  return "running";
}

function planIcon(status: FeishuPlanStepProjection["status"]): string {
  if (status === "completed") return "✅";
  if (status === "in_progress") return "▶️";
  return "⬜";
}

function toolIcon(status: FeishuToolProjection["status"]): string {
  if (status === "completed") return "✅";
  if (status === "failed") return "❌";
  return "⏳";
}

function toolStatusLabel(status: FeishuToolProjection["status"]): string {
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "进行中";
}

function isSubagentTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "agent" ||
    normalized === "task" ||
    normalized.includes("spawn_agent") ||
    normalized.includes("subagent")
  );
}

function safeToolName(value: unknown): string | undefined {
  return safeIdentifier(value, 80);
}

function safeBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return safeLine(basename(normalized), 120) || "file";
}

function escapeLine(value: string): string {
  return safeVisibleText(value, 1_200)
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "_")
    .trim();
}

function escapeUnsafeCardMarkup(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "[已移除脚本]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeLine(value: string, limit: number): string {
  return safeVisibleText(value, limit)
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "_")
    .trim();
}

function safeVisibleText(value: string, limit: number): string {
  const scanLimit = Math.max(2_048, limit + 1_024);
  const inputTruncated = value.length > scanLimit;
  let output = stripControlCharacters(value.slice(0, scanLimit)).replace(
    /<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi,
    "[已移除脚本]",
  );

  output = renderLocalMarkdownLinksAsText(output);
  if (inputTruncated) output += "…";
  return clip(output, limit);
}

/**
 * CardKit cannot open a path on the Yep host. Keep both the assistant's label
 * and its original path as readable text instead of sending an unusable link
 * destination that the client may replace with an "address hidden" marker.
 */
function renderLocalMarkdownLinksAsText(value: string): string {
  return value.replace(
    /\[([^\]\r\n]+)\]\(\s*(<(?:(?:file:\/\/\/|~\/|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^>\r\n]+)>|(?:(?:file:\/\/\/|~\/|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^)\r\n]+))\s*\)/g,
    (_match, label: string, rawTarget: string) => {
      const target = rawTarget.startsWith("<")
        ? rawTarget.slice(1, -1).trim()
        : rawTarget.trim();
      const visibleLabel = label.trim();
      if (!visibleLabel || visibleLabel === target) return target;
      return `${visibleLabel}（\`${target.replaceAll("`", "\\`")}\`）`;
    },
  );
}

function stripControlCharacters(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code < 32 &&
        character !== "\n" &&
        character !== "\r" &&
        character !== "\t") ||
      code === 127
    ) {
      continue;
    }
    output += character;
  }
  return output;
}

function safeIdentifier(value: unknown, limit: number): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const identifier = safeVisibleText(raw, limit)
    .replace(/[^\p{L}\p{N}_.:/ -]/gu, "_")
    .trim();
  return identifier || undefined;
}

function safeInternalId(value: string): string {
  return safeIdentifier(value, 160) ?? "item";
}

function canonicalItemId(
  item: Record<string, unknown>,
  message: Record<string, unknown>,
  nativeType: CodexNativeThreadItemType,
): string {
  const id =
    stringValue(item.id) ??
    stringValue(message.uuid) ??
    `${nativeType}-${numberValue(message.codexEventSequence) ?? 0}`;
  return safeInternalId(id);
}

function isCodexNativeThreadItemType(
  value: string,
): value is CodexNativeThreadItemType {
  return Object.hasOwn(CODEX_THREAD_ITEM_KIND_BY_NATIVE_TYPE, value);
}

function subagentActivityLabel(value: unknown): string {
  if (value === "started") return "开始";
  if (value === "interacted") return "交互";
  if (value === "interrupted") return "中断";
  return "更新";
}

function safeDurationLabel(value: unknown): string | undefined {
  const durationMs = numberValue(value);
  if (durationMs === undefined || durationMs < 0) return undefined;
  const bounded = Math.min(durationMs, 86_400_000);
  if (bounded < 1_000) return `${Math.round(bounded)} ms`;
  if (bounded < 60_000) return `${Math.round(bounded / 100) / 10} 秒`;
  return `${Math.round(bounded / 6_000) / 10} 分钟`;
}

function safeStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .filter((item): item is string => typeof item === "string" && !!item);
}

function setBoundedMap<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function addBoundedSet<T>(set: Set<T>, value: T, limit: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > limit) {
    const oldest = set.values().next();
    if (oldest.done) return;
    set.delete(oldest.value);
  }
}

function clip(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
