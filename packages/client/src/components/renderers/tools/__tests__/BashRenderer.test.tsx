import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bashRenderer } from "../BashRenderer";
import { parseBenchmarkReviewBlock } from "../BenchmarkReviewRenderer";

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
    ignoreToolErrors: vi.fn(),
    clearIgnoredTools: vi.fn(),
    ignoredTools: [],
  }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};

const benchmarkReviewOutput = `=== BENCHMARK_RUN_REVIEW_RESULT_START ===
{
  "run": {
    "task_id": "j-9oi4c3ufw4",
    "benchmark": "aime_25_hf",
    "model_under_test": "talos_vision",
    "run_count": 480,
    "success_count": 431,
    "failure_count": 49,
    "reward": 0.8979166666666667
  },
  "read_scope": {
    "benchmark_run_id": 26
  },
  "benchmark_profile": {
    "primary_task_form": "AIME 2025 math benchmark with 30 cases and 16 repeats."
  },
  "failure_overview": {
    "failed_case_count": 10,
    "failure_rate_by_run": 0.10208333333333335
  },
  "failure_patterns": [
    {
      "pattern_id": "pattern_1",
      "pattern": "High-failure math reasoning errors",
      "description": "Cases 14, 29, and 13 frequently return wrong numeric answers.",
      "case_count": 3,
      "run_count": 37,
      "affected_cases": ["14", "29", "13"],
      "sampled_cases": ["14"],
      "evidence_strength": "high"
    }
  ],
  "case_inventory": {
    "included_cases": [
      {
        "case_key": "14",
        "failure_class": "partial_failure",
        "pattern_ids": ["pattern_1"],
        "runs": 16,
        "failed_runs": 15,
        "note": "Highest failure-rate case."
      }
    ]
  },
  "evidence_gaps": [
    {
      "case_key": "14",
      "reason": "No trajectory file is available."
    }
  ]
}
=== BENCHMARK_RUN_REVIEW_RESULT_END ===`;

describe("BashRenderer benchmark review output", () => {
  afterEach(() => {
    cleanup();
  });

  it("parses marker-wrapped benchmark review JSON", () => {
    const parsed = parseBenchmarkReviewBlock(benchmarkReviewOutput);

    expect(parsed?.data.run).toMatchObject({
      task_id: "j-9oi4c3ufw4",
      benchmark: "aime_25_hf",
    });
  });

  it("renders benchmark review output as structured sections", () => {
    const { container } = render(
      <div>
        {bashRenderer.renderToolResult(
          benchmarkReviewOutput as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("Benchmark review result")).toBeDefined();
    expect(
      container.querySelector(".benchmark-review-title")?.textContent,
    ).toBe("j-9oi4c3ufw4 / aime_25_hf");
    expect(screen.getByText("Failure patterns")).toBeDefined();
    expect(
      screen.getByText("High-failure math reasoning errors"),
    ).toBeDefined();
    expect(screen.getByText("Cases and pattern links")).toBeDefined();
    expect(screen.getByText("15/16")).toBeDefined();
    expect(screen.getByText("Evidence gaps")).toBeDefined();
    expect(screen.queryByText(/BENCHMARK_RUN_REVIEW_RESULT_START/)).toBeNull();
  });
});

describe("BashRenderer provider command context", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the normalized Pi command beside an expanded result", () => {
    render(
      <div>
        {bashRenderer.renderToolResult(
          {
            stdout: "done",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          false,
          { ...renderContext, provider: "pi" },
          { command: "echo pi" },
        )}
      </div>,
    );

    expect(screen.getByText("Command")).toBeDefined();
    expect(screen.getByText("echo pi")).toBeDefined();
    expect(screen.getByText("done")).toBeDefined();
  });
});
