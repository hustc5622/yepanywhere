import {
  fetchLlmGatewayModels,
  resolveDefaultLlmGatewayChannel,
} from "../packages/server/src/llm-gateways/index.js";
import { benchmarkOhMyRouterModel } from "../packages/server/src/services/OhMyRouterBenchmarkService.js";

const config = resolveDefaultLlmGatewayChannel(process.env);
if (!config || new URL(config.apiBase).hostname !== "api.ohmyrouter.com") {
  throw new Error(
    "Configure YEP_LLM_GATEWAY_API_KEY or LLM_API_KEY for api.ohmyrouter.com before running this script.",
  );
}

const startedAt = new Date().toISOString();
const models = await fetchLlmGatewayModels(config);
const results = [];
for (const model of models) {
  const result = await benchmarkOhMyRouterModel({ config, model });
  results.push(result);
  const outcome = result.error
    ? `failed: ${result.error}`
    : `${result.tokensPerSecond?.toFixed(1)} tokens/s`;
  console.log(`${model.id}: ${outcome}`);
}

console.log(
  JSON.stringify(
    {
      startedAt,
      completedAt: new Date().toISOString(),
      totalModels: models.length,
      results,
    },
    null,
    2,
  ),
);
