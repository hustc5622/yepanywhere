/**
 * Translate agy `ask_question` elicitations (ACP `elicitation/create`, form
 * mode) into Yep's AskUserQuestion input, and answers back.
 *
 * Observed schema (references/antigravity/probe/trace-step4.jsonl):
 *   properties: {
 *     q1: {type:"string", title, oneOf:[{const:"1", title:"red"}, ...]},
 *     q1_other: {type:"string", title:"Other", description:"Optional ..."},
 *   }
 * Multi-select questions use `{type:"array", items:{anyOf|oneOf|enum}}`.
 * Answers are option `const` values (arrays for multi-select) plus optional
 * free text in `<id>_other`.
 */

export interface AgyQuestionOption {
  label: string;
  value: string;
  description: string;
}

export interface AgyQuestion {
  id: string;
  question: string;
  header: string;
  options: AgyQuestionOption[];
  multiSelect: boolean;
  custom: boolean;
  required: boolean;
}

interface StepPlan {
  id: string;
  kind: "single" | "multi" | "text";
  options: AgyQuestionOption[];
  otherKey?: string;
}

export interface AgyQuestionnairePlan {
  questions: AgyQuestion[];
  steps: StepPlan[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptions(list: unknown): AgyQuestionOption[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): AgyQuestionOption[] => {
    if (typeof entry === "string") {
      return [{ label: entry, value: entry, description: "" }];
    }
    if (!isRecord(entry) || typeof entry.const !== "string") return [];
    return [
      {
        label:
          typeof entry.title === "string" && entry.title.trim()
            ? entry.title
            : entry.const,
        value: entry.const,
        description:
          typeof entry.description === "string" ? entry.description : "",
      },
    ];
  });
}

function arrayItemOptions(items: unknown): AgyQuestionOption[] {
  if (!isRecord(items)) return [];
  return readOptions(items.anyOf ?? items.oneOf ?? items.enum);
}

export function planAgyQuestionnaire(
  requestedSchema: unknown,
  message: string | undefined,
): AgyQuestionnairePlan | null {
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) {
    return null;
  }
  const properties = requestedSchema.properties;
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter(
          (key): key is string => typeof key === "string",
        )
      : [],
  );
  const otherKeys = new Set(
    Object.keys(properties).filter(
      (key) =>
        key.endsWith("_other") && key.slice(0, -"_other".length) in properties,
    ),
  );
  const steps: StepPlan[] = [];
  const questions: AgyQuestion[] = [];
  for (const [key, prop] of Object.entries(properties)) {
    if (otherKeys.has(key)) continue;
    if (!isRecord(prop)) return null;
    let kind: StepPlan["kind"];
    let options: AgyQuestionOption[] = [];
    if (prop.type === "array") {
      kind = "multi";
      options = arrayItemOptions(prop.items);
    } else if (prop.type === "string" && (prop.oneOf || prop.enum)) {
      kind = "single";
      options = readOptions(prop.oneOf ?? prop.enum);
    } else if (prop.type === "string") {
      kind = "text";
    } else {
      return null;
    }
    const otherKey = otherKeys.has(`${key}_other`) ? `${key}_other` : undefined;
    steps.push({ id: key, kind, options, ...(otherKey ? { otherKey } : {}) });
    questions.push({
      id: key,
      question:
        typeof prop.title === "string" && prop.title.trim()
          ? prop.title
          : (message ?? key),
      header: "Question",
      options,
      multiSelect: kind === "multi",
      custom: kind === "text" || Boolean(otherKey),
      required: required.has(key),
    });
  }
  if (questions.length === 0) return null;
  return { questions, steps };
}

/** Convert Yep answers (keyed by question id) into elicitation content. */
export function buildAgyElicitationContent(
  plan: AgyQuestionnairePlan,
  answers: Record<string, unknown>,
): Record<string, string | string[]> {
  const content: Record<string, string | string[]> = {};
  for (const step of plan.steps) {
    const raw = answers[step.id];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );
    if (values.length === 0) continue;
    if (step.kind === "text") {
      content[step.id] = values.join("\n");
      continue;
    }
    const selected: string[] = [];
    const others: string[] = [];
    for (const value of values) {
      const option = step.options.find(
        (candidate) => candidate.value === value || candidate.label === value,
      );
      if (option) selected.push(option.value);
      else others.push(value);
    }
    if (step.kind === "multi") {
      if (selected.length > 0) content[step.id] = selected;
    } else if (selected[0]) {
      content[step.id] = selected[0];
    }
    if (others.length > 0 && step.otherKey) {
      content[step.otherKey] = others.join("\n");
    }
  }
  return content;
}
