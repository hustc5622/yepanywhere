import type {
  InputRequest,
  UserQuestionAnswer,
  UserQuestionAnswers,
} from "@yep-anywhere/shared";
import { redactSensitivePublicText } from "../../codex-events/redaction.js";

export const FEISHU_ACTION_NAMESPACE = "yep-feishu";

export type FeishuInputAction =
  | "approve"
  | "approve_always"
  | "deny"
  | "answer"
  | "submit";

export interface FeishuInputActionValue {
  namespace: typeof FEISHU_ACTION_NAMESPACE;
  /** Central InteractionBroker identity. No channel-local claim id exists. */
  operationId: string;
  operationVersion: number;
  action: FeishuInputAction;
  optionIndex?: number;
}

export interface FeishuCardActionEvent {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  actionTag: string;
  value: unknown;
  option?: string;
  formValue?: Record<string, unknown>;
}

interface ProjectedQuestion {
  key: string;
  prompt: string;
  options: Array<{ label: string; value: string }>;
  multiSelect: boolean;
  required: boolean;
  inputType?: string;
}

const MAX_PROMPT_CHARS = 1_200;
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 20;

export function parseFeishuInputActionValue(
  value: unknown,
): FeishuInputActionValue | undefined {
  const record = asRecord(value);
  if (
    record?.namespace !== FEISHU_ACTION_NAMESPACE ||
    typeof record.operationId !== "string" ||
    !/^int_[A-Za-z0-9_-]{16,124}$/u.test(record.operationId) ||
    typeof record.operationVersion !== "number" ||
    !Number.isSafeInteger(record.operationVersion) ||
    record.operationVersion < 0 ||
    !isInputAction(record.action)
  ) {
    return undefined;
  }
  const optionIndex =
    typeof record.optionIndex === "number" &&
    Number.isInteger(record.optionIndex) &&
    record.optionIndex >= 0
      ? record.optionIndex
      : undefined;
  return {
    namespace: FEISHU_ACTION_NAMESPACE,
    operationId: record.operationId,
    operationVersion: record.operationVersion,
    action: record.action,
    ...(optionIndex !== undefined ? { optionIndex } : {}),
  };
}

export function buildFeishuInputCard(
  request: InputRequest,
  identity: {
    operationId: string;
    operationVersion: number;
  },
): object {
  if (request.type === "tool-approval") {
    return buildApprovalCard(request, identity);
  }
  return buildQuestionCard(request, identity);
}

export function buildFeishuResolvedInputCard(input: {
  requestType: InputRequest["type"];
  status: "completed" | "expired" | "cancelled" | "failed";
  terminalReason?:
    | "timeout"
    | "interrupt"
    | "process_exit"
    | "request_missing"
    | "provider_rejected"
    | "failed";
  result?: "approve" | "approve_always" | "deny" | "answered";
  nativeDecision?: {
    kind:
      | "accept"
      | "acceptForSession"
      | "acceptWithExecpolicyAmendment"
      | "applyNetworkPolicyAmendment"
      | "decline"
      | "cancel"
      | "answer";
    scope: "once" | "session" | "policy" | "none";
  };
}): object {
  const completed = input.status === "completed";
  const status = completed
    ? input.result === "deny"
      ? "已拒绝"
      : input.result === "answered"
        ? "已提交回答"
        : input.result === "approve_always"
          ? input.nativeDecision?.kind === "acceptWithExecpolicyAmendment"
            ? "命令策略已应用"
            : input.nativeDecision?.kind === "applyNetworkPolicyAmendment"
              ? "网络策略已应用"
              : "本 Session 已允许"
          : "已允许"
    : input.status === "cancelled"
      ? "操作已取消"
      : input.status === "expired"
        ? input.terminalReason === "request_missing"
          ? "请求已结束，可能已在 Yep 或其他客户端处理"
          : "操作已超时"
        : "处理失败，请在 Yep 中查看";
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      template: completed
        ? "green"
        : input.status === "cancelled"
          ? "grey"
          : input.status === "expired"
            ? "grey"
            : "red",
      title: {
        tag: "plain_text",
        content:
          input.requestType === "tool-approval" ? "Codex 审批" : "Codex 问题",
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: "result_status",
          content: `**${status}**`,
        },
      ],
    },
  };
}

export function buildFeishuQuestionAnswers(
  request: InputRequest,
  event: Pick<FeishuCardActionEvent, "formValue" | "option">,
  action: FeishuInputActionValue,
): UserQuestionAnswers | undefined {
  const questions = projectQuestions(request);
  if (questions.length === 0) return undefined;
  const answers: UserQuestionAnswers = {};

  if (action.action === "answer" && action.optionIndex !== undefined) {
    const question = questions[0];
    const option = question?.options[action.optionIndex];
    if (question && option) answers[question.key] = option.value;
    return Object.keys(answers).length > 0 ? answers : undefined;
  }

  const values = event.formValue ?? {};
  questions.forEach((question, index) => {
    const raw = values[`q_${index}`];
    const answer = decodeQuestionAnswer(question, raw);
    if (answer !== undefined) answers[question.key] = answer;
  });

  if (Object.keys(answers).length === 0 && event.option && questions[0]) {
    const answer = decodeQuestionAnswer(questions[0], event.option);
    if (answer !== undefined) answers[questions[0].key] = answer;
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function buildApprovalCard(
  request: InputRequest,
  identity: Parameters<typeof buildFeishuInputCard>[1],
): object {
  const toolName = sanitizePlainText(request.toolName ?? "Tool", 80);
  const prompt = escapeCardMarkdown(request.prompt, MAX_PROMPT_CHARS);
  const columns = [
    buttonColumn("允许一次", "primary", actionValue(identity, "approve")),
    ...(offersPersistentApproval(request.toolInput)
      ? [
          buttonColumn(
            persistentApprovalLabel(request.toolInput),
            "default",
            actionValue(identity, "approve_always"),
          ),
        ]
      : []),
    buttonColumn("拒绝", "danger", actionValue(identity, "deny")),
  ];
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "Codex 请求确认" },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: "approval_summary",
          content: `**工具：${escapeCardMarkdown(toolName, 80)}**\n\n${prompt || "Codex 请求执行操作。"}`,
        },
        {
          tag: "column_set",
          element_id: "approval_actions",
          flex_mode: "flow",
          columns,
        },
        safetyNotice(),
      ],
    },
  };
}

function offersPersistentApproval(toolInput: unknown): boolean {
  const availableDecisions = asRecord(toolInput)?.availableDecisions;
  return (
    Array.isArray(availableDecisions) &&
    availableDecisions.some((decision) => {
      if (decision === "acceptForSession") return true;
      const nativeDecision = asRecord(decision);
      return (
        asRecord(nativeDecision?.acceptWithExecpolicyAmendment) !== undefined ||
        asRecord(nativeDecision?.applyNetworkPolicyAmendment) !== undefined
      );
    })
  );
}

function persistentApprovalLabel(toolInput: unknown): string {
  const availableDecisions = asRecord(toolInput)?.availableDecisions;
  if (!Array.isArray(availableDecisions)) return "本 Session 允许";
  if (availableDecisions.includes("acceptForSession")) {
    return "本 Session 允许";
  }
  for (const decision of availableDecisions) {
    const nativeDecision = asRecord(decision);
    if (asRecord(nativeDecision?.acceptWithExecpolicyAmendment)) {
      return "应用命令策略";
    }
    if (asRecord(nativeDecision?.applyNetworkPolicyAmendment)) {
      return "应用网络策略";
    }
  }
  return "本 Session 允许";
}

function buildQuestionCard(
  request: InputRequest,
  identity: Parameters<typeof buildFeishuInputCard>[1],
): object {
  const questions = projectQuestions(request);
  const unsupported =
    questions.length === 0 ||
    questions.some((question) => question.inputType === "password");
  const elements: object[] = [
    {
      tag: "markdown",
      element_id: "question_intro",
      content: escapeCardMarkdown(
        request.prompt || "Codex 需要你的回答。",
        MAX_PROMPT_CHARS,
      ),
    },
  ];

  if (unsupported) {
    elements.push({
      tag: "markdown",
      element_id: "question_unsupported",
      content: "该问题包含不适合在群聊卡片中填写的内容，请在 Yep 中回答。",
    });
  } else if (
    questions.length === 1 &&
    !questions[0]?.multiSelect &&
    questions[0]?.options.length &&
    questions[0].options.length <= 5
  ) {
    const question = questions[0];
    elements.push({
      tag: "markdown",
      element_id: "question_0",
      content: `**${escapeCardMarkdown(question.prompt, 500)}**`,
    });
    elements.push({
      tag: "column_set",
      element_id: "question_choices",
      flex_mode: "flow",
      columns: question.options.map((option, index) =>
        buttonColumn(
          option.label,
          index === 0 ? "primary" : "default",
          actionValue(identity, "answer", index),
        ),
      ),
    });
  } else {
    elements.push(buildQuestionForm(questions, identity));
  }
  elements.push(
    buttonElement(
      "拒绝 / 取消",
      "danger",
      actionValue(identity, "deny"),
      "deny_button",
    ),
    safetyNotice(),
  );

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Codex 需要输入" },
    },
    body: { elements },
  };
}

function buildQuestionForm(
  questions: ProjectedQuestion[],
  identity: Parameters<typeof buildFeishuInputCard>[1],
): object {
  const elements: object[] = [];
  questions.forEach((question, index) => {
    elements.push({
      tag: "markdown",
      element_id: `q_label_${index}`,
      content: `**${escapeCardMarkdown(question.prompt, 500)}**`,
    });
    if (question.options.length > 0) {
      elements.push({
        tag: question.multiSelect ? "multi_select_static" : "select_static",
        element_id: `q_select_${index}`,
        name: `q_${index}`,
        required: question.required,
        width: "fill",
        placeholder: { tag: "plain_text", content: "请选择" },
        options: question.options.map((option, optionIndex) => ({
          text: {
            tag: "plain_text",
            content: sanitizePlainText(option.label, 100),
          },
          value: String(optionIndex),
        })),
      });
      return;
    }
    elements.push({
      tag: "input",
      element_id: `q_input_${index}`,
      name: `q_${index}`,
      required: question.required,
      width: "fill",
      input_type: question.inputType === "text" ? "multiline_text" : "text",
      max_length: 2_000,
      placeholder: { tag: "plain_text", content: "请输入回答" },
    });
  });
  elements.push({
    ...buttonElement(
      "提交回答",
      "primary",
      actionValue(identity, "submit"),
      "submit_button",
    ),
    form_action_type: "submit",
  });
  return {
    tag: "form",
    element_id: "question_form",
    name: "question_form",
    elements,
  };
}

function projectQuestions(request: InputRequest): ProjectedQuestion[] {
  const input = asRecord(request.toolInput);
  const rawQuestions = Array.isArray(input?.questions)
    ? input.questions.slice(0, MAX_QUESTIONS)
    : [];
  const questions = rawQuestions.flatMap((raw, index) => {
    const question = asRecord(raw);
    if (!question) return [];
    const prompt = readString(question.question) ?? `问题 ${index + 1}`;
    const key = readString(question.id) ?? prompt;
    const options = Array.isArray(question.options)
      ? question.options.slice(0, MAX_OPTIONS).flatMap((rawOption) => {
          const option = asRecord(rawOption);
          if (!option) return [];
          const label = readString(option.label) ?? readString(option.value);
          if (!label) return [];
          return [
            {
              label: sanitizePlainText(label, 100),
              value: readString(option.value) ?? label,
            },
          ];
        })
      : [];
    return [
      {
        key,
        prompt,
        options,
        multiSelect: question.multiSelect === true,
        required: question.required !== false,
        inputType: readString(question.inputType),
      },
    ];
  });
  if (questions.length > 0) return questions;
  const options = (request.options ?? [])
    .slice(0, MAX_OPTIONS)
    .map((option) => ({
      label: sanitizePlainText(option, 100),
      value: option,
    }));
  return options.length > 0
    ? [
        {
          key: request.id,
          prompt: request.prompt,
          options,
          multiSelect: false,
          required: true,
        },
      ]
    : [];
}

function decodeQuestionAnswer(
  question: ProjectedQuestion,
  raw: unknown,
): UserQuestionAnswer | undefined {
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const decoded = values.flatMap((value) => {
    if (typeof value !== "string" || !value.trim()) return [];
    if (question.options.length === 0) return [value.trim()];
    const index = Number(value);
    const option = Number.isInteger(index)
      ? question.options[index]
      : undefined;
    if (option) return [option.value];
    const byValue = question.options.find(
      (candidate) => candidate.value === value,
    );
    return byValue ? [byValue.value] : [];
  });
  if (decoded.length === 0) return undefined;
  return question.multiSelect ? decoded : decoded[0];
}

function actionValue(
  identity: Parameters<typeof buildFeishuInputCard>[1],
  action: FeishuInputAction,
  optionIndex?: number,
): FeishuInputActionValue {
  return {
    namespace: FEISHU_ACTION_NAMESPACE,
    operationId: identity.operationId,
    operationVersion: identity.operationVersion,
    action,
    ...(optionIndex !== undefined ? { optionIndex } : {}),
  };
}

function buttonColumn(
  label: string,
  type: "primary" | "default" | "danger",
  value: FeishuInputActionValue,
): object {
  return {
    tag: "column",
    width: "auto",
    elements: [buttonElement(label, type, value)],
  };
}

function buttonElement(
  label: string,
  type: "primary" | "default" | "danger",
  value: FeishuInputActionValue,
  elementId?: string,
): object {
  return {
    tag: "button",
    ...(elementId ? { element_id: elementId } : {}),
    text: { tag: "plain_text", content: sanitizePlainText(label, 100) },
    type,
    behaviors: [{ type: "callback", value }],
  };
}

function safetyNotice(): object {
  return {
    tag: "div",
    element_id: "safety_notice",
    text: {
      tag: "plain_text",
      content: "仅任务发起者或该机器人账号的管理员可以操作。",
      text_size: "notation",
      text_color: "grey",
    },
  };
}

function escapeCardMarkdown(value: string, limit: number): string {
  return sanitizePlainText(value, limit)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sanitizePlainText(value: string, limit: number): string {
  return Array.from(redactSensitivePublicText(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function isInputAction(value: unknown): value is FeishuInputAction {
  return ["approve", "approve_always", "deny", "answer", "submit"].includes(
    String(value),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
