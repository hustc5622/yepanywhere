import {
  fetchOpenCodeGatewayModels,
  resolveOpenCodeGatewayConfig,
} from "../packages/server/src/opencode-bridge/gateway-config.js";
import { benchmarkOhMyRouterModel } from "../packages/server/src/services/OhMyRouterBenchmarkService.js";

const config = resolveOpenCodeGatewayConfig(process.env);
if (!config || new URL(config.apiBase).hostname !== "api.ohmyrouter.com") {
  throw new Error(
    "Configure OPENCODE_LLM_API_KEY, SESSION_TITLE_LLM_API_KEY, or LLM_API_KEY for api.ohmyrouter.com before running this script.",
  );
}

const startedAt = new Date().toISOString();
const models = await fetchOpenCodeGatewayModels(config);
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
