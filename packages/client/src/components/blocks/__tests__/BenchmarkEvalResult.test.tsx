import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchmarkEvalResult,
  parseBenchmarkEvalResultBlock,
} from "../BenchmarkEvalResult";
import { TextBlock } from "../TextBlock";

const placeholderResult = `=== BENCHMARK_EVAL_RESULT_START ===
{"summary":"placeholder"}
=== BENCHMARK_EVAL_RESULT_END ===`;

const finalResult = `=== BENCHMARK_EVAL_RESULT_START ===
{
  "benchmark_profile": {
    "benchmark_type": "数学/结构化推理类",
    "primary_task_form": "在有向图上执行 BFS 或父节点查找",
    "case_format": "自然语言指令与结构化边列表",
    "answer_oracle": "外部评分服务",
    "domain_scope": ["图论", "长上下文推理"],
    "taxonomy_status": "partial",
    "classification_confidence": "high"
  },
  "summary": "该 benchmark 主要测试长上下文中的结构化推理与算法执行能力。",
  "summary_md": "## 完整报告\\n\\n这是完整的评估说明。",
  "case_count": 150,
  "sample_read_scope": {
    "estimated_read_case_count": 150,
    "unread_scope_note": "尚未覆盖 256k-1M 的 case。",
    "machine_audit_used": true
  },
  "data_quality_findings": {
    "control_character_case_count": 0,
    "title_truncation_case_count": 0,
    "empty_improved_problem_statement_case_count": 150,
    "notes": "题面截断影响实际操作验证。"
  },
  "capability_profile": [
    {
      "capability": "结构化推理",
      "weight": "primary",
      "evidence": "样本要求精确执行图遍历算法。",
      "representative_cases": [{"case_id": 5882, "benchmark_id": "graphwalks-1", "reason": "包含 BFS 示例。"}],
      "limitations": "样本题面存在截断。"
    }
  ],
  "capability_gaps": [{"capability": "工具使用", "reason": "没有环境交互。"}],
  "scorecard": {
    "coverage": {"score": 2, "reason": "没有覆盖全部上下文区间。"}
  },
  "strengths": ["任务定义清晰"],
  "risks": ["题面截断"],
  "recommendations": ["修复抽样管道"],
  "priority_actions": [{"priority": "P0", "action": "保留完整题面", "reason": "避免验收信号丢失。"}],
  "notable_cases": [{"case_id": 5882, "benchmark_id": "graphwalks-1", "note": "代表图遍历任务。"}]
}
=== BENCHMARK_EVAL_RESULT_END ===`;

describe("BenchmarkEvalResult", () => {
  afterEach(cleanup);

  it("uses the latest complete result when a template precedes it", () => {
    const parsed = parseBenchmarkEvalResultBlock(
      `${placeholderResult}\n${finalResult}`,
    );

    expect(parsed?.matchedBlockCount).toBe(2);
    expect(parsed?.data.summary).toContain("结构化推理");
  });

  it("renders benchmark evaluation JSON as structured sections", () => {
    const parsed = parseBenchmarkEvalResultBlock(finalResult);
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("Expected a benchmark evaluation result");

    const { container } = render(<BenchmarkEvalResult block={parsed} />);

    expect(screen.getByText("数学/结构化推理类")).toBeTruthy();
    expect(screen.getByText("能力画像")).toBeTruthy();
    expect(screen.getByText("结构化推理")).toBeTruthy();
    expect(screen.getByText("评估评分")).toBeTruthy();
    expect(screen.getByText("P0")).toBeTruthy();
    expect(screen.queryByText("BENCHMARK_EVAL_RESULT_START")).toBeNull();

    const summary = container.querySelector(".benchmark-eval-summary");
    if (!summary) throw new Error("Expected the benchmark summary");
    expect(summary.classList.contains("benchmark-eval-summary-expanded")).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "展开摘要" }));
    expect(summary.classList.contains("benchmark-eval-summary-expanded")).toBe(
      true,
    );
  });

  it("uses the structured rendering in normal assistant text blocks", () => {
    render(<TextBlock text={`${placeholderResult}\n${finalResult}`} />);

    expect(screen.getByText("任务与分类")).toBeTruthy();
    expect(screen.queryByText(/placeholder/)).toBeNull();
  });
});
