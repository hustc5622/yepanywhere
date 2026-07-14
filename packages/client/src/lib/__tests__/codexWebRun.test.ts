import { describe, expect, it } from "vitest";
import {
  getCodexWebResultOverview,
  getCodexWebRunOverview,
} from "../codexWebRun";

describe("Codex web__run parsing", () => {
  it("extracts the real code-mode search_query shape without evaluating it", () => {
    const overview = getCodexWebRunOverview({
      script:
        'const r = await tools.web__run({search_query:[{q:"site:home-assistant.io getting started automation"},{"q":"site:home-assistant.io/integrations Xiaomi Home"},{q:\'GitHub XiaoMi ha_xiaomi_home\'},{q:`Home Assistant Matter`}],response_length:"long"});text(JSON.stringify(r));',
    });

    expect(overview).toMatchObject({
      operationCount: 1,
      requestCount: 4,
      queryCount: 4,
      responseLength: "long",
      summary: "Search · 4 queries",
      operations: [
        {
          kind: "search",
          items: [
            "site:home-assistant.io getting started automation",
            "site:home-assistant.io/integrations Xiaomi Home",
            "GitHub XiaoMi ha_xiaomi_home",
            "Home Assistant Matter",
          ],
        },
      ],
    });
  });

  it("turns the completed response into sources and readable output", () => {
    const webOutput = [
      "Xiaomi Home - Home Assistant (https://www.home-assistant.io/integrations/xiaomi_miio/)",
      "citeturn21search0 [wordlim: 200] Crawled: 6 days ago",
      "",
      "[Xiaomi official integration](https://github.com/XiaoMi/ha_xiaomi_home)",
    ].join("\n");
    const result = [
      {
        type: "input_text",
        text: "Script completed\nWall time 2.5 seconds\nOutput:\n",
      },
      { type: "input_text", text: JSON.stringify(webOutput) },
    ];

    const overview = getCodexWebResultOverview(result);

    expect(overview.exec.status).toBe("completed");
    expect(overview.exec.wallTimeSeconds).toBe(2.5);
    expect(overview.output).toBe(webOutput);
    expect(overview.sources).toEqual([
      {
        title: "Xiaomi Home - Home Assistant",
        url: "https://www.home-assistant.io/integrations/xiaomi_miio/",
      },
      {
        title: "Xiaomi official integration",
        url: "https://github.com/XiaoMi/ha_xiaomi_home",
      },
    ]);
  });

  it("preserves the running cell effect without inventing output", () => {
    const overview = getCodexWebResultOverview(
      "Script running with cell ID 1\nWall time 10.0 seconds\nOutput:\n",
    );

    expect(overview).toMatchObject({
      exec: { status: "running", cellId: "1", wallTimeSeconds: 10 },
      output: "",
      sources: [],
    });
  });
});
