import type {
  LlmGatewayRequestProtocol,
  ModelInfo,
} from "@yep-anywhere/shared";

export type ModelReasoningEffort = NonNullable<
  ModelInfo["supportedReasoningEfforts"]
>[number];

export function getModelReasoningEfforts(
  model: ModelInfo | undefined,
  protocol?: LlmGatewayRequestProtocol,
): ModelReasoningEffort[] {
  const seen = new Set<string>();
  const efforts: ModelReasoningEffort[] = [];

  const advertisedEfforts =
    protocol && model?.supportedReasoningEffortsByProtocol
      ? (model.supportedReasoningEffortsByProtocol[protocol] ?? [])
      : model?.supportedReasoningEfforts;

  for (const option of advertisedEfforts ?? []) {
    const reasoningEffort = option.reasoningEffort.trim();
    if (!reasoningEffort || seen.has(reasoningEffort)) continue;
    seen.add(reasoningEffort);
    efforts.push({ ...option, reasoningEffort });
  }

  return efforts;
}

export function resolveModelReasoningEffort(
  model: ModelInfo | undefined,
  preferredReasoningEffort?: string | null,
  protocol?: LlmGatewayRequestProtocol,
): string | undefined {
  const efforts = getModelReasoningEfforts(model, protocol);
  const preferred = preferredReasoningEffort?.trim();
  if (
    preferred &&
    efforts.some((option) => option.reasoningEffort === preferred)
  ) {
    return preferred;
  }

  const modelDefault = model?.defaultReasoningEffort?.trim();
  if (
    modelDefault &&
    efforts.some((option) => option.reasoningEffort === modelDefault)
  ) {
    return modelDefault;
  }

  if (efforts.length > 0) {
    return efforts[0]?.reasoningEffort;
  }

  return preferred || modelDefault || undefined;
}
