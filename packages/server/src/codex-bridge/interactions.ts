import type {
  InputRequest,
  UserQuestionAnswer,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { asRecord } from "../bridge-common/util.js";
import type {
  CodexBridgeInputResponse,
  JsonRpcId,
  JsonRpcMessage,
} from "./types.js";

/**
 * Codex-only boundary between app-server server requests and Yep's generic
 * pending-input UI. Keep wire responses aligned with
 * references/codex/codex-rs/app-server-protocol/src/protocol/{common,v2}.
 */

export type CodexInteractiveMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/permissions/requestApproval"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request"
  | "execCommandApproval"
  | "applyPatchApproval";

export interface CodexInteractiveRequestView {
  inputRequest: InputRequest;
  pendingInputType: "tool-approval" | "user-question";
}

interface QuestionOptionView {
  label: string;
  description: string;
  value: string;
}

interface QuestionView {
  id: string;
  header: string;
  question: string;
  options: QuestionOptionView[];
  multiSelect: boolean;
  custom: boolean;
  required: boolean;
  inputType?:
    | "text"
    | "password"
    | "number"
    | "email"
    | "url"
    | "date"
    | "datetime-local";
  defaultValue?: string | string[];
}

export function isCodexInteractiveMethod(
  method: string,
): method is CodexInteractiveMethod {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "item/tool/requestUserInput" ||
    method === "mcpServer/elicitation/request" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  );
}

export function buildCodexPendingInputId(
  connectionId: number,
  message: JsonRpcMessage,
  threadId: string,
  params: Record<string, unknown>,
): string {
  return [
    `connection:${connectionId}`,
    idKey(message.id as JsonRpcId),
    message.method,
    threadId,
    getString(params.turnId),
    getString(params.itemId),
    getString(params.callId),
    getString(params.approvalId),
  ]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("|");
}

export function toCodexInteractiveRequestView(
  id: string,
  method: CodexInteractiveMethod,
  threadId: string,
  params: Record<string, unknown>,
  timestamp: string,
): CodexInteractiveRequestView {
  const base = {
    id,
    sessionId: threadId,
    timestamp,
    source: "codex-bridge" as const,
  };

  if (method === "item/tool/requestUserInput") {
    const questions = normalizeCodexQuestions(params.questions);
    return {
      pendingInputType: "user-question",
      inputRequest: {
        ...base,
        type: "question",
        prompt: questions[0]?.question ?? "Codex needs input",
        toolName: "AskUserQuestion",
        toolInput: {
          questions,
          allowPartialSubmission: true,
          autoResolutionMs: getFiniteNumber(params.autoResolutionMs) ?? null,
          codexQuestions: params.questions ?? [],
        },
      },
    };
  }

  if (method === "mcpServer/elicitation/request") {
    return toMcpElicitationRequestView(base, threadId, params);
  }

  if (method === "item/permissions/requestApproval") {
    return {
      pendingInputType: "tool-approval",
      inputRequest: {
        ...base,
        type: "tool-approval",
        prompt: getString(params.reason) ?? "Allow requested permissions?",
        toolName: "Permissions",
        toolInput: {
          approvalKind: "permissions",
          cwd: params.cwd,
          reason: params.reason,
          permissions: params.permissions,
          environmentId: params.environmentId,
          availableDecisions: ["accept", "acceptForSession", "decline"],
          threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          callId: params.callId,
        },
      },
    };
  }

  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  ) {
    return {
      pendingInputType: "tool-approval",
      inputRequest: {
        ...base,
        type: "tool-approval",
        prompt: getString(params.reason) ?? "Allow file changes?",
        toolName: "Edit",
        toolInput: {
          approvalKind: "file_change",
          reason: params.reason,
          grantRoot: params.grantRoot,
          fileChanges: params.fileChanges,
          threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          callId: params.callId,
        },
      },
    };
  }

  return {
    pendingInputType: "tool-approval",
    inputRequest: {
      ...base,
      type: "tool-approval",
      prompt: getString(params.reason) ?? "Allow command?",
      toolName: "Bash",
      toolInput: {
        approvalKind: "command_execution",
        command: params.command,
        cwd: params.cwd,
        reason: params.reason,
        commandActions: params.commandActions,
        additionalPermissions: params.additionalPermissions,
        availableDecisions: params.availableDecisions,
        networkApprovalContext: params.networkApprovalContext,
        proposedExecpolicyAmendment: params.proposedExecpolicyAmendment,
        proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments,
        threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        callId: params.callId,
        approvalId: params.approvalId,
      },
    },
  };
}

export function buildCodexInteractiveResponse(
  method: CodexInteractiveMethod,
  params: Record<string, unknown>,
  response: CodexBridgeInputResponse,
  answers?: UserQuestionAnswers,
): unknown {
  const approved = response !== "deny";
  const approveForSession =
    response === "approve_accept_edits" || response === "approve_for_session";
  const approveStrictAutoReview = response === "approve_strict_auto_review";
  const approveAlways = response === "approve_always";

  switch (method) {
    case "item/commandExecution/requestApproval":
      return {
        decision: approved
          ? approveForSession
            ? getCommandPersistentApprovalDecision(params)
            : "accept"
          : "decline",
      };
    case "item/fileChange/requestApproval":
      return {
        decision: approved
          ? approveForSession
            ? "acceptForSession"
            : "accept"
          : "decline",
      };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: approved ? "approved" : "denied" };
    case "item/permissions/requestApproval": {
      if (!approved) {
        return { permissions: {}, scope: "turn" };
      }
      const requested = asRecord(params.permissions);
      const granted: Record<string, unknown> = {};
      const network = requested?.network;
      const fileSystem = requested?.fileSystem;
      if (network !== null && network !== undefined) granted.network = network;
      if (fileSystem !== null && fileSystem !== undefined) {
        granted.fileSystem = fileSystem;
      }
      return {
        permissions: granted,
        scope: approveForSession ? "session" : "turn",
        ...(approveStrictAutoReview ? { strictAutoReview: true } : {}),
      };
    }
    case "item/tool/requestUserInput":
      return {
        answers: buildCodexUserInputAnswers(params.questions, answers),
      };
    case "mcpServer/elicitation/request":
      return buildMcpElicitationResponse(
        params,
        approved,
        approveForSession,
        approveAlways,
        answers,
      );
  }
}

export function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function toMcpElicitationRequestView(
  base: Pick<InputRequest, "id" | "sessionId" | "timestamp" | "source">,
  threadId: string,
  params: Record<string, unknown>,
): CodexInteractiveRequestView {
  const meta = getElicitationMeta(params);
  const message = getString(params.message) ?? "Codex needs MCP input";
  const serverName =
    getString(params.serverName) ??
    getString(meta?.connector_name) ??
    getString(meta?.connector_id);

  if (isMcpToolApprovalAction(params)) {
    const mcpToolName =
      getString(meta?.tool_name) ?? parseMcpToolNameFromPrompt(message);
    return {
      pendingInputType: "tool-approval",
      inputRequest: {
        ...base,
        type: "tool-approval",
        prompt: message,
        toolName: "MCP",
        toolInput: {
          approvalKind: "mcp_tool_call",
          approvalPrompt: message,
          serverName,
          mcpToolName,
          toolTitle: getString(meta?.tool_title) ?? mcpToolName,
          toolDescription: meta?.tool_description,
          toolParams: meta?.tool_params,
          toolParamsDisplay: meta?.tool_params_display,
          persistScopes: normalizeMcpPersistScopes(meta?.persist),
          threadId,
          turnId: params.turnId,
          raw: params,
        },
      },
    };
  }

  if (isMcpToolSuggestion(params)) {
    const actionUrl = normalizeExternalUrl(meta?.install_url);
    return {
      pendingInputType: "tool-approval",
      inputRequest: {
        ...base,
        type: "tool-approval",
        prompt: getString(meta?.suggest_reason) ?? message,
        toolName: "MCP",
        toolInput: {
          approvalKind: "mcp_tool_suggestion",
          approvalPrompt: message,
          serverName,
          toolType: meta?.tool_type,
          toolId: meta?.tool_id,
          toolName: meta?.tool_name,
          suggestType: meta?.suggest_type,
          suggestReason: meta?.suggest_reason,
          ...(actionUrl ? { actionUrl } : {}),
          actionLabel:
            getString(meta?.suggest_type) === "enable"
              ? "Open app settings"
              : "Open installation page",
          threadId,
          turnId: params.turnId,
          raw: params,
        },
      },
    };
  }

  if (getString(params.mode) === "url") {
    const actionUrl = normalizeExternalUrl(params.url);
    return {
      pendingInputType: "tool-approval",
      inputRequest: {
        ...base,
        type: "tool-approval",
        prompt: message,
        toolName: "MCP",
        toolInput: {
          approvalKind: "mcp_url_action",
          approvalPrompt: message,
          serverName,
          ...(actionUrl ? { actionUrl } : {}),
          actionLabel: "Open required page",
          elicitationId: params.elicitationId,
          threadId,
          turnId: params.turnId,
          raw: params,
        },
      },
    };
  }

  const questions = normalizeMcpFormQuestions(params.requestedSchema);
  if (questions.length > 0) {
    return {
      pendingInputType: "user-question",
      inputRequest: {
        ...base,
        type: "question",
        prompt: message,
        toolName: "AskUserQuestion",
        toolInput: {
          questions,
          allowPartialSubmission: false,
          mcpElicitation: {
            mode: params.mode,
            serverName,
            message,
            requestedSchema: params.requestedSchema,
          },
        },
      },
    };
  }

  return {
    pendingInputType: "tool-approval",
    inputRequest: {
      ...base,
      type: "tool-approval",
      prompt: message,
      toolName: "MCP",
      toolInput: {
        approvalKind: "mcp_elicitation",
        approvalPrompt: message,
        serverName,
        threadId,
        turnId: params.turnId,
        raw: params,
      },
    },
  };
}

function buildMcpElicitationResponse(
  params: Record<string, unknown>,
  approved: boolean,
  approveForSession: boolean,
  approveAlways: boolean,
  answers: UserQuestionAnswers | undefined,
): Record<string, unknown> {
  if (isMcpToolApprovalAction(params)) {
    const meta: Record<string, unknown> = {};
    if (approveForSession) meta.persist = "session";
    if (approveAlways) meta.persist = "always";
    return {
      action: approved ? "accept" : "cancel",
      content: null,
      _meta: approved && Object.keys(meta).length > 0 ? meta : null,
    };
  }

  if (!approved) {
    return { action: "decline", content: null, _meta: null };
  }

  if (
    getString(params.mode) === "url" ||
    isMcpToolSuggestion(params) ||
    isMessageOnlyMcpSchema(params.requestedSchema)
  ) {
    return { action: "accept", content: null, _meta: null };
  }

  return {
    action: "accept",
    content: buildMcpElicitationContent(params.requestedSchema, answers),
    _meta: null,
  };
}

function getCommandPersistentApprovalDecision(
  params: Record<string, unknown>,
): unknown {
  const availableDecisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : [];
  const offeredPersistentDecision = availableDecisions.find(
    isPersistentCommandDecision,
  );
  if (offeredPersistentDecision) return offeredPersistentDecision;

  if (Array.isArray(params.proposedExecpolicyAmendment)) {
    return {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: params.proposedExecpolicyAmendment,
      },
    };
  }

  const networkAmendments = Array.isArray(
    params.proposedNetworkPolicyAmendments,
  )
    ? params.proposedNetworkPolicyAmendments
    : [];
  const networkAmendment = networkAmendments.find(
    (value) => asRecord(value) !== null,
  );
  if (networkAmendment) {
    return {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: networkAmendment,
      },
    };
  }

  return availableDecisions.includes("acceptForSession")
    ? "acceptForSession"
    : "accept";
}

function normalizeCodexQuestions(value: unknown): QuestionView[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw, index) => {
      const question = asRecord(raw);
      if (!question) return null;
      const prompt = getString(question.question) ?? getString(question.header);
      if (!prompt) return null;
      const id = getString(question.id) ?? `question_${index + 1}`;
      const options = Array.isArray(question.options)
        ? question.options
            .map((rawOption) => {
              const option = asRecord(rawOption);
              const label =
                typeof rawOption === "string"
                  ? rawOption
                  : getString(option?.label);
              if (!label) return null;
              return {
                label,
                description: getString(option?.description) ?? "",
                value: label,
              };
            })
            .filter((option): option is QuestionOptionView => !!option)
        : [];
      const result: QuestionView = {
        id,
        header: getString(question.header) ?? `Question ${index + 1}`,
        question: prompt,
        options,
        multiSelect: false,
        custom: question.isOther === true,
        required: true,
      };
      if (question.isSecret === true) result.inputType = "password";
      return result;
    })
    .filter((question): question is QuestionView => !!question);
}

function normalizeMcpFormQuestions(value: unknown): QuestionView[] {
  const schema = asRecord(value);
  const properties = asRecord(schema?.properties);
  if (!properties) return [];
  const requiredIds = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((id): id is string => typeof id === "string")
      : [],
  );

  return Object.entries(properties).map(([id, rawProperty], index) => {
    const property = asRecord(rawProperty) ?? {};
    const type = getSchemaType(property);
    const options = getMcpSchemaOptions(property, type);
    const title = getString(property.title) ?? id;
    const question: QuestionView = {
      id,
      header: title,
      question: getString(property.description) ?? title,
      options,
      multiSelect: type === "array",
      custom: options.length === 0,
      required: requiredIds.has(id),
    };

    if (options.length === 0) {
      question.inputType = mcpInputType(property, type);
    }
    const defaultValue = property.default;
    if (typeof defaultValue === "string") {
      question.defaultValue = defaultValue;
    } else if (typeof defaultValue === "number") {
      question.defaultValue = String(defaultValue);
    } else if (typeof defaultValue === "boolean") {
      question.defaultValue = String(defaultValue);
    } else if (
      Array.isArray(defaultValue) &&
      defaultValue.every((item): item is string => typeof item === "string")
    ) {
      question.defaultValue = defaultValue;
    }

    if (!question.header) question.header = `Field ${index + 1}`;
    return question;
  });
}

function getMcpSchemaOptions(
  property: Record<string, unknown>,
  type: string | undefined,
): QuestionOptionView[] {
  if (type === "boolean") {
    return [
      { label: "Yes", description: "", value: "true" },
      { label: "No", description: "", value: "false" },
    ];
  }

  const optionSource = type === "array" ? asRecord(property.items) : property;
  if (!optionSource) return [];
  const titled = Array.isArray(optionSource.oneOf)
    ? optionSource.oneOf
    : Array.isArray(optionSource.anyOf)
      ? optionSource.anyOf
      : null;
  if (titled) {
    return titled
      .map((rawOption) => {
        const option = asRecord(rawOption);
        const value = getPrimitiveString(option?.const);
        if (value === undefined) return null;
        return {
          label: getString(option?.title) ?? value,
          description: getString(option?.description) ?? "",
          value,
        };
      })
      .filter((option): option is QuestionOptionView => !!option);
  }

  const enumValues = Array.isArray(optionSource.enum) ? optionSource.enum : [];
  const enumNames = Array.isArray(optionSource.enumNames)
    ? optionSource.enumNames
    : [];
  return enumValues
    .map((value, index) => {
      const stringValue = getPrimitiveString(value);
      if (stringValue === undefined) return null;
      return {
        label:
          typeof enumNames[index] === "string"
            ? (enumNames[index] as string)
            : stringValue,
        description: "",
        value: stringValue,
      };
    })
    .filter((option): option is QuestionOptionView => !!option);
}

function mcpInputType(
  property: Record<string, unknown>,
  type: string | undefined,
): QuestionView["inputType"] {
  if (type === "number" || type === "integer") return "number";
  const format = getString(property.format);
  if (format === "email") return "email";
  if (format === "uri") return "url";
  if (format === "date") return "date";
  if (format === "date-time") return "datetime-local";
  return property.secret === true ? "password" : "text";
}

function buildCodexUserInputAnswers(
  questionsValue: unknown,
  answers: UserQuestionAnswers | undefined,
): Record<string, { answers: string[] }> {
  const result: Record<string, { answers: string[] }> = {};
  if (!Array.isArray(questionsValue)) return result;

  for (const raw of questionsValue) {
    const question = asRecord(raw);
    const id = getString(question?.id);
    if (!id) continue;
    const prompt = getString(question?.question) ?? getString(question?.header);
    const answer = answers?.[id] ?? (prompt ? answers?.[prompt] : undefined);
    if (answer === undefined) continue;
    const optionLabels = new Set(
      Array.isArray(question?.options)
        ? question.options
            .map((option) =>
              typeof option === "string"
                ? option
                : getString(asRecord(option)?.label),
            )
            .filter((option): option is string => !!option)
        : [],
    );
    const values = answerValues(answer).map((value) =>
      optionLabels.has(value) || value.startsWith("user_note:")
        ? value
        : `user_note: ${value}`,
    );
    if (values.length > 0) result[id] = { answers: values };
  }
  return result;
}

function buildMcpElicitationContent(
  schemaValue: unknown,
  answers: UserQuestionAnswers | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = asRecord(asRecord(schemaValue)?.properties);
  if (!properties || !answers) return result;

  for (const [id, rawProperty] of Object.entries(properties)) {
    const answer = answers[id];
    if (answer === undefined) continue;
    const property = asRecord(rawProperty) ?? {};
    const type = getSchemaType(property);
    const values = answerValues(answer);
    if (type === "array") {
      result[id] = values;
    } else if (type === "boolean") {
      const normalized = values[0]?.toLowerCase();
      if (normalized === "true" || normalized === "false") {
        result[id] = normalized === "true";
      }
    } else if (type === "number" || type === "integer") {
      const number = Number(values[0]);
      if (Number.isFinite(number)) {
        result[id] = type === "integer" ? Math.trunc(number) : number;
      }
    } else if (values[0] !== undefined) {
      result[id] = values[0];
    }
  }
  return result;
}

function answerValues(answer: UserQuestionAnswer | undefined): string[] {
  if (Array.isArray(answer)) {
    return answer.map((value) => value.trim()).filter(Boolean);
  }
  const value = answer?.trim();
  return value ? [value] : [];
}

function getElicitationMeta(
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  return asRecord(params._meta) ?? asRecord(params.meta);
}

function isMcpToolApprovalAction(params: Record<string, unknown>): boolean {
  const meta = getElicitationMeta(params);
  return (
    getString(meta?.codex_approval_kind) === "mcp_tool_call" &&
    isMessageOnlyMcpSchema(params.requestedSchema)
  );
}

function isMcpToolSuggestion(params: Record<string, unknown>): boolean {
  const meta = getElicitationMeta(params);
  return (
    getString(meta?.codex_approval_kind) === "tool_suggestion" &&
    isMessageOnlyMcpSchema(params.requestedSchema)
  );
}

function isMessageOnlyMcpSchema(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const schema = asRecord(value);
  const properties = asRecord(schema?.properties);
  return getString(schema?.type) === "object" && !!properties
    ? Object.keys(properties).length === 0
    : false;
}

function normalizeMcpPersistScopes(value: unknown): string[] {
  const scopes = (Array.isArray(value) ? value : [value]).filter(
    (scope): scope is string => scope === "session" || scope === "always",
  );
  return Array.from(new Set(scopes));
}

function parseMcpToolNameFromPrompt(prompt: string): string | undefined {
  return /run tool "([^"]+)"/.exec(prompt)?.[1];
}

function normalizeExternalUrl(value: unknown): string | undefined {
  const url = getString(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function getSchemaType(property: Record<string, unknown>): string | undefined {
  if (typeof property.type === "string") return property.type;
  if (Array.isArray(property.type)) {
    return property.type.find(
      (value): value is string => typeof value === "string" && value !== "null",
    );
  }
  return undefined;
}

function getPrimitiveString(value: unknown): string | undefined {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? String(value)
    : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isPersistentCommandDecision(value: unknown): boolean {
  const decision = asRecord(value);
  return (
    !!asRecord(decision?.acceptWithExecpolicyAmendment) ||
    !!asRecord(decision?.applyNetworkPolicyAmendment)
  );
}
