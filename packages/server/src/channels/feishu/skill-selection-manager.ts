import { randomBytes } from "node:crypto";
import type { FeishuSessionBinding } from "@yep-anywhere/shared";
import {
  containsSensitiveText,
  redactSensitivePublicText,
} from "../../codex-events/redaction.js";
import type { CodexStructuredUserInput } from "../../sdk/types.js";
import type { FeishuCardActionEvent } from "./input-request.js";
import type { FeishuMessageApi } from "./normalization/types.js";
import {
  type FeishuStreamingReplyTarget,
  hasFeishuInteractionApi,
} from "./outbound.js";

export const MAX_FEISHU_SKILL_CHOICES = 12;
export const DEFAULT_FEISHU_SKILL_SELECTION_TTL_MS = 5 * 60 * 1_000;

export type FeishuSkillCardActionResult =
  | "ignored"
  | "claimed"
  | "forbidden"
  | "expired"
  | "stale";

export interface FeishuSkillPickerContext {
  accountId: string;
  scopeKey: string;
  sessionId: string;
  chatId: string;
  threadId?: string;
  replyToMessageId: string;
  requesterOpenId: string;
  api?: FeishuMessageApi;
}

export interface FeishuSkillPickerPresentation {
  mode: "card" | "text";
  text: string;
  shown: number;
  total: number;
}

export interface FeishuSkillSelectionLease {
  accountId: string;
  scopeKey: string;
  sessionId: string;
  requesterOpenId: string;
  version: number;
  codexInputs: [CodexStructuredUserInput];
}

interface PublicSkill {
  name: string;
  invokeName: string;
  description: string;
  path?: string;
}

interface SkillGrant {
  token: string;
  accountId: string;
  scopeKey: string;
  sessionId: string;
  chatId: string;
  requesterOpenId: string;
  name: string;
  displayName: string;
  path: string;
  version: number;
  cardId: string;
  cardMessageId: string;
  api?: FeishuMessageApi;
  expiresAt: number;
}

interface PendingSkillSelection {
  accountId: string;
  scopeKey: string;
  sessionId: string;
  requesterOpenId: string;
  name: string;
  displayName: string;
  path: string;
  version: number;
  cardId: string;
  api?: FeishuMessageApi;
  expiresAt: number;
}

interface SkillActionValue {
  token: string;
}

const MAX_SKILL_NAME_CHARS = 80;
const MAX_SKILL_DESCRIPTION_CHARS = 160;
const MAX_SKILL_PATH_CHARS = 4_096;
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/**
 * Process-local broker for Feishu skill selection. Skill paths deliberately
 * never enter a card, action payload, durable store, or log field.
 */
export class FeishuSkillSelectionManager {
  private readonly getBinding: (
    scopeKey: string,
  ) => FeishuSessionBinding | undefined;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly createToken: () => string;
  private readonly grants = new Map<string, SkillGrant>();
  private readonly activePickerVersionByScope = new Map<string, number>();
  private readonly pendingByScope = new Map<string, PendingSkillSelection>();
  private readonly nextVersionByScope = new Map<string, number>();
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private shuttingDown = false;

  constructor(options: {
    getBinding(scopeKey: string): FeishuSessionBinding | undefined;
    now?: () => number;
    ttlMs?: number;
    createToken?: () => string;
  }) {
    this.getBinding = options.getBinding;
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(
      1,
      options.ttlMs ?? DEFAULT_FEISHU_SKILL_SELECTION_TTL_MS,
    );
    this.createToken =
      options.createToken ?? (() => randomBytes(16).toString("hex"));
  }

  async presentPicker(
    context: FeishuSkillPickerContext,
    data: unknown,
  ): Promise<FeishuSkillPickerPresentation> {
    this.pruneExpired();
    const skills = readPublicSkills(data);
    const fallback = formatSkillFallback(skills);
    const eligible = skills.filter(
      (skill): skill is PublicSkill & { path: string } => Boolean(skill.path),
    );
    if (
      this.shuttingDown ||
      !hasFeishuInteractionApi(context.api) ||
      eligible.length === 0
    ) {
      return {
        mode: "text",
        text: fallback,
        shown: Math.min(eligible.length, MAX_FEISHU_SKILL_CHOICES),
        total: skills.length,
      };
    }

    const visible = eligible.slice(0, MAX_FEISHU_SKILL_CHOICES);
    const version = (this.nextVersionByScope.get(context.scopeKey) ?? 0) + 1;
    const expiresAt = this.now() + this.ttlMs;
    const reservedTokens = new Set<string>();
    const grants = visible.map((skill) => ({
      token: this.createOpaqueToken(reservedTokens),
      skill,
    }));
    let card: { cardId: string; messageId: string };
    try {
      card = await context.api.createInputCard(
        createTarget(context),
        buildSkillPickerCard(grants, skills.length, this.ttlMs),
      );
    } catch {
      return {
        mode: "text",
        text: fallback,
        shown: visible.length,
        total: skills.length,
      };
    }

    this.deleteGrantsForScope(context.scopeKey);
    this.nextVersionByScope.set(context.scopeKey, version);
    this.activePickerVersionByScope.set(context.scopeKey, version);
    for (const { token, skill } of grants) {
      this.grants.set(token, {
        token,
        accountId: context.accountId,
        scopeKey: context.scopeKey,
        sessionId: context.sessionId,
        chatId: context.chatId,
        requesterOpenId: context.requesterOpenId,
        name: skill.invokeName,
        displayName: skill.name,
        path: skill.path,
        version,
        cardId: card.cardId,
        cardMessageId: card.messageId,
        api: context.api,
        expiresAt,
      });
    }
    this.scheduleExpiry();
    return {
      mode: "card",
      text: `已发送 Skills 选择卡片（显示 ${visible.length}/${skills.length}）。选择后，你的下一条正常消息将使用该 Skill。`,
      shown: visible.length,
      total: skills.length,
    };
  }

  async acceptCardAction(input: {
    accountId: string;
    event: FeishuCardActionEvent;
    api?: FeishuMessageApi;
    adminUsers: readonly string[];
  }): Promise<FeishuSkillCardActionResult> {
    if (this.shuttingDown) return "ignored";
    const value = parseSkillActionValue(input.event.value);
    if (!value) return "ignored";

    const grant = this.grants.get(value.token);
    if (!grant) return "stale";
    if (grant.expiresAt <= this.now()) {
      this.deleteGrantsForScope(grant.scopeKey);
      this.activePickerVersionByScope.delete(grant.scopeKey);
      this.scheduleExpiry();
      await this.updateCard(
        grant.api ?? input.api,
        grant.cardId,
        buildResolvedSkillCard("expired"),
        1,
      );
      return "expired";
    }
    if (
      input.accountId !== grant.accountId ||
      input.event.chatId !== grant.chatId ||
      input.event.messageId !== grant.cardMessageId
    ) {
      return "stale";
    }
    if (
      input.event.operatorOpenId !== grant.requesterOpenId &&
      !input.adminUsers.includes(input.event.operatorOpenId)
    ) {
      return "forbidden";
    }
    const binding = this.getBinding(grant.scopeKey);
    if (
      !binding ||
      binding.scopeKey !== grant.scopeKey ||
      binding.accountId !== grant.accountId ||
      binding.chatId !== grant.chatId ||
      binding.sessionId !== grant.sessionId ||
      this.activePickerVersionByScope.get(grant.scopeKey) !== grant.version
    ) {
      return "stale";
    }

    // Claim synchronously before the first await so duplicate callbacks cannot
    // overwrite or consume one another.
    this.deleteGrantsForScope(grant.scopeKey);
    this.activePickerVersionByScope.delete(grant.scopeKey);
    this.pendingByScope.set(grant.scopeKey, {
      accountId: grant.accountId,
      scopeKey: grant.scopeKey,
      sessionId: grant.sessionId,
      requesterOpenId: grant.requesterOpenId,
      name: grant.name,
      displayName: grant.displayName,
      path: grant.path,
      version: grant.version,
      cardId: grant.cardId,
      api: grant.api ?? input.api,
      expiresAt: this.now() + this.ttlMs,
    });
    this.scheduleExpiry();
    await this.updateCard(
      grant.api ?? input.api,
      grant.cardId,
      buildResolvedSkillCard("selected", grant.displayName),
      1,
    );
    return "claimed";
  }

  peekForNextMessage(input: {
    accountId: string;
    scopeKey: string;
    sessionId: string;
    requesterOpenId: string;
  }): FeishuSkillSelectionLease | undefined {
    this.pruneExpired();
    const pending = this.pendingByScope.get(input.scopeKey);
    if (
      !pending ||
      pending.accountId !== input.accountId ||
      pending.sessionId !== input.sessionId ||
      pending.requesterOpenId !== input.requesterOpenId
    ) {
      return undefined;
    }
    return {
      accountId: pending.accountId,
      scopeKey: pending.scopeKey,
      sessionId: pending.sessionId,
      requesterOpenId: pending.requesterOpenId,
      version: pending.version,
      codexInputs: [{ type: "skill", name: pending.name, path: pending.path }],
    };
  }

  async consume(lease: FeishuSkillSelectionLease): Promise<boolean> {
    const pending = this.pendingByScope.get(lease.scopeKey);
    const selected = lease.codexInputs[0];
    if (
      !pending ||
      pending.accountId !== lease.accountId ||
      pending.sessionId !== lease.sessionId ||
      pending.requesterOpenId !== lease.requesterOpenId ||
      pending.version !== lease.version ||
      selected.type !== "skill" ||
      selected.name !== pending.name ||
      selected.path !== pending.path
    ) {
      return false;
    }
    this.pendingByScope.delete(lease.scopeKey);
    this.scheduleExpiry();
    await this.updateCard(
      pending.api,
      pending.cardId,
      buildResolvedSkillCard("consumed", pending.displayName),
      2,
    );
    return true;
  }

  clearScope(scopeKey: string): void {
    this.deleteGrantsForScope(scopeKey);
    this.activePickerVersionByScope.delete(scopeKey);
    this.pendingByScope.delete(scopeKey);
    this.nextVersionByScope.delete(scopeKey);
    this.scheduleExpiry();
  }

  shutdown(): void {
    this.shuttingDown = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.grants.clear();
    this.activePickerVersionByScope.clear();
    this.pendingByScope.clear();
    this.nextVersionByScope.clear();
  }

  private createOpaqueToken(reserved: Set<string>): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = this.createToken();
      if (
        /^[a-f0-9]{32}$/.test(token) &&
        !this.grants.has(token) &&
        !reserved.has(token)
      ) {
        reserved.add(token);
        return token;
      }
    }
    let token: string;
    do {
      token = randomBytes(16).toString("hex");
    } while (this.grants.has(token) || reserved.has(token));
    reserved.add(token);
    return token;
  }

  private deleteGrantsForScope(scopeKey: string): void {
    for (const [token, grant] of this.grants) {
      if (grant.scopeKey === scopeKey) this.grants.delete(token);
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    const expiredPickerScopes = new Set<string>();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(token);
        expiredPickerScopes.add(grant.scopeKey);
      }
    }
    for (const scopeKey of expiredPickerScopes) {
      if (
        ![...this.grants.values()].some((grant) => grant.scopeKey === scopeKey)
      ) {
        this.activePickerVersionByScope.delete(scopeKey);
      }
    }
    for (const [scopeKey, pending] of this.pendingByScope) {
      if (pending.expiresAt <= now) this.pendingByScope.delete(scopeKey);
    }
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.shuttingDown) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const grant of this.grants.values()) {
      earliest = Math.min(earliest, grant.expiresAt);
    }
    for (const pending of this.pendingByScope.values()) {
      earliest = Math.min(earliest, pending.expiresAt);
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.min(
      MAX_TIMEOUT_DELAY_MS,
      Math.max(1, earliest - this.now()),
    );
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      this.pruneExpired();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private async updateCard(
    api: FeishuMessageApi | undefined,
    cardId: string,
    card: object,
    sequence: number,
  ): Promise<void> {
    if (!hasFeishuInteractionApi(api)) return;
    await api.updateInputCard(cardId, card, sequence).catch(() => undefined);
  }
}

function createTarget(
  context: FeishuSkillPickerContext,
): FeishuStreamingReplyTarget {
  return {
    chatId: context.chatId,
    replyToMessageId: context.replyToMessageId,
    replyInThread: Boolean(context.threadId),
  };
}

function readPublicSkills(data: unknown): PublicSkill[] {
  const root = asRecord(data);
  const entries = Array.isArray(root?.data) ? root.data : [];
  const skills: PublicSkill[] = [];
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    if (!Array.isArray(entry?.skills)) continue;
    for (const skillValue of entry.skills) {
      const skill = asRecord(skillValue);
      if (skill?.enabled === false) continue;
      const rawName = readString(skill?.name);
      if (!rawName || containsSensitiveText(rawName)) continue;
      const name = sanitizePublicText(
        redactSensitivePublicText(rawName),
        MAX_SKILL_NAME_CHARS,
      ).replace(/[<>]/g, "_");
      if (!name) continue;
      const rawPath = readString(skill?.path);
      skills.push({
        name,
        invokeName: rawName,
        description: sanitizePublicText(
          redactSensitivePublicText(readString(skill?.description) ?? ""),
          MAX_SKILL_DESCRIPTION_CHARS,
        ),
        ...(rawPath && rawPath.length <= MAX_SKILL_PATH_CHARS
          ? { path: rawPath }
          : {}),
      });
    }
  }
  return skills;
}

function formatSkillFallback(skills: PublicSkill[]): string {
  if (skills.length === 0) return "当前没有可用 Skills。";
  const visible = skills.slice(0, MAX_FEISHU_SKILL_CHOICES);
  const lines = visible.map((skill) =>
    skill.description
      ? `- ${escapeCardMarkdown(skill.name)} — ${escapeCardMarkdown(skill.description)}`
      : `- ${escapeCardMarkdown(skill.name)}`,
  );
  if (skills.length > visible.length) {
    lines.push(`…另有 ${skills.length - visible.length} 项未显示。`);
  }
  return [`可用 Skills（${skills.length}）：`, ...lines].join("\n");
}

function buildSkillPickerCard(
  grants: Array<{ token: string; skill: PublicSkill }>,
  total: number,
  ttlMs: number,
): object {
  const elements: object[] = [
    {
      tag: "div",
      element_id: "skill_picker_intro",
      text: {
        tag: "plain_text",
        content: `选择一个 Skill；它只会应用到你的下一条正常消息。卡片约 ${Math.max(1, Math.ceil(ttlMs / 60_000))} 分钟后失效。`,
        text_size: "notation",
        text_color: "grey",
      },
    },
  ];
  grants.forEach(({ token, skill }, index) => {
    elements.push({
      tag: "markdown",
      element_id: `skill_${index}_description`,
      content: skill.description
        ? `**${escapeCardMarkdown(skill.name)}**\n${escapeCardMarkdown(skill.description)}`
        : `**${escapeCardMarkdown(skill.name)}**`,
    });
    elements.push({
      tag: "button",
      element_id: `skill_${index}_select`,
      text: { tag: "plain_text", content: `选择 ${skill.name}` },
      type: index === 0 ? "primary" : "default",
      behaviors: [
        {
          type: "callback",
          value: {
            token,
          } satisfies SkillActionValue,
        },
      ],
    });
  });
  if (total > grants.length) {
    elements.push({
      tag: "div",
      element_id: "skill_picker_truncated",
      text: {
        tag: "plain_text",
        content: `另有 ${total - grants.length} 项未显示。`,
        text_size: "notation",
        text_color: "grey",
      },
    });
  }
  elements.push({
    tag: "div",
    element_id: "skill_picker_safety",
    text: {
      tag: "plain_text",
      content: "仅命令发起者或该机器人账号的管理员可以选择。",
      text_size: "notation",
      text_color: "grey",
    },
  });
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Codex Skills" },
    },
    body: { elements },
  };
}

function buildResolvedSkillCard(
  status: "selected" | "consumed" | "expired",
  name?: string,
): object {
  const content =
    status === "selected"
      ? `已选择 **${escapeCardMarkdown(name ?? "Skill")}**。你的下一条正常消息将使用它；发送失败时会保留选择。`
      : status === "consumed"
        ? `已将 **${escapeCardMarkdown(name ?? "Skill")}** 应用于消息。`
        : "该 Skills 选择卡片已过期，请重新运行 `/codex skills`。";
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      template: status === "expired" ? "grey" : "green",
      title: { tag: "plain_text", content: "Codex Skills" },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: "skill_selection_status",
          content,
        },
      ],
    },
  };
}

function parseSkillActionValue(value: unknown): SkillActionValue | undefined {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.token !== "string" ||
    !/^[a-f0-9]{32}$/.test(record.token) ||
    Object.keys(record).some((key) => key !== "token")
  ) {
    return undefined;
  }
  return { token: record.token };
}

function sanitizePublicText(value: string, maxChars: number): string {
  const withoutPaths = value
    .replace(/file:\/\/\/[^\s]+/gi, "[path]")
    .replace(/(^|[\s([{"'`=])\/(?:[^/\s]+\/)+(?:[^\s)\]}"'`,;]*)/g, "$1[path]")
    .replace(/(^|[\s([{"'`=])~\/(?:[^\s]+)/g, "$1[path]")
    .replace(/(^|[\s([{"'`=])[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "$1[path]");
  return Array.from(withoutPaths, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function escapeCardMarkdown(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
