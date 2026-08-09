import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FeishuOutboundApi,
  FeishuStreamingReplyTarget,
} from "../../../src/channels/feishu/outbound.js";
import { FeishuReplyController } from "../../../src/channels/feishu/reply-controller.js";

describe("FeishuReplyController", () => {
  const controllers: FeishuReplyController[] = [];

  afterEach(async () => {
    await Promise.all(
      controllers.splice(0).map((controller) => controller.detach()),
    );
  });

  it("coalesces provider text into a sequenced CardKit terminal update", async () => {
    const api = makeOutboundApi();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-1",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent("message", userMessage("temp-1"));

    await controller.handleRuntimeEvent("message", streamDelta("Hello "));
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash<script>",
            input: { command: "print-secret-token" },
          },
          { type: "text", text: "Hello world" },
        ],
      },
    });
    await controller.handleRuntimeEvent("status", { state: "idle" });

    expect(controller.state).toBe("completed");
    expect(controller.text).toBe("Hello world");
    expect(api.createStreamingReply).toHaveBeenCalledWith(
      TARGET,
      expect.stringContaining("正在处理"),
    );
    const updates = api.updateStreamingReply.mock.calls;
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[1]).toContain("Hello world");
    expect(updates[0]?.[1]).not.toContain("print-secret-token");
    expect(updates[0]?.[2]).toBe(1);
    expect(api.finishStreamingReply).toHaveBeenCalledWith(
      "card-1",
      2,
      "Hello world",
    );
  });

  it("updates stable rich-card regions without replaying prior progress", async () => {
    const api = {
      ...makeOutboundApi(),
      updateStreamingReplySection: vi.fn(async () => undefined),
      createStreamingReplySection: vi.fn(async () => undefined),
      deleteStreamingReplySection: vi.fn(async () => undefined),
    } satisfies FeishuOutboundApi;
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-sections",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-sections"),
    );
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      uuid: "progress-1",
      codexMessagePhase: "commentary",
      message: { content: "第一步完成" },
    });
    await vi.waitFor(() =>
      expect(
        api.createStreamingReplySection.mock.calls.filter(
          (call) => call[1] === "yep_stream_prog_01",
        ),
      ).toHaveLength(1),
    );
    const firstProgress = api.createStreamingReplySection.mock.calls.find(
      (call) => call[1] === "yep_stream_prog_01",
    )?.[2];
    const firstProgressUpdateCount =
      api.updateStreamingReplySection.mock.calls.filter(
        (call) => call[1] === "yep_stream_prog_01",
      ).length;

    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      uuid: "progress-2",
      codexMessagePhase: "commentary",
      message: { content: "第二步完成" },
    });
    await vi.waitFor(() =>
      expect(
        api.createStreamingReplySection.mock.calls
          .filter((call) => call[1] === "yep_stream_prog_02")
          .at(-1)?.[2],
      ).toBe("第二步完成"),
    );
    expect(
      api.updateStreamingReplySection.mock.calls.filter(
        (call) => call[1] === "yep_stream_prog_01",
      ),
    ).toHaveLength(firstProgressUpdateCount);
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "mcp-section",
            name: "lark:lark_speech_recognize",
            status: "in_progress",
            input: { file_path: "/private/input.audio" },
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        api.createStreamingReplySection.mock.calls
          .filter((call) => call[1] === "yep_stream_act_01")
          .at(-1)?.[2],
      ).toContain("lark:lark_speech_recognize · 进行中"),
    );
    await controller.handleRuntimeEvent("message", {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "mcp-section",
            content: "failed",
            is_error: true,
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        api.updateStreamingReplySection.mock.calls
          .filter((call) => call[1] === "yep_stream_act_01")
          .at(-1)?.[2],
      ).toContain("lark:lark_speech_recognize · 失败"),
    );
    const firstToolUpdateCount =
      api.updateStreamingReplySection.mock.calls.filter(
        (call) => call[1] === "yep_stream_act_01",
      ).length;
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "mcp-section-2",
            name: "lark:lark_speech_recognize",
            status: "in_progress",
            input: { file_path: "/private/input-2.audio" },
          },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        api.createStreamingReplySection.mock.calls
          .filter((call) => call[1] === "yep_stream_act_02")
          .at(-1)?.[2],
      ).toContain("lark:lark_speech_recognize · 进行中"),
    );
    expect(
      api.updateStreamingReplySection.mock.calls.filter(
        (call) => call[1] === "yep_stream_act_01",
      ),
    ).toHaveLength(firstToolUpdateCount);
    await controller.handleRuntimeEvent("status", { state: "idle" });

    const progressHeader = api.createStreamingReplySection.mock.calls
      .filter((call) => call[1] === "yep_stream_progress")
      .at(-1)?.[2];
    const toolsHeader = api.createStreamingReplySection.mock.calls
      .filter((call) => call[1] === "yep_stream_tools")
      .at(-1)?.[2];
    const firstTool = api.updateStreamingReplySection.mock.calls
      .filter((call) => call[1] === "yep_stream_act_01")
      .at(-1)?.[2];
    expect(progressHeader).toBe("### 进展");
    expect(firstProgress).toBe("第一步完成");
    expect(toolsHeader).toBe("### 工具与活动");
    expect(firstTool).toContain("lark:lark_speech_recognize · 失败");
    expect(firstTool).not.toContain("/private/input.audio");
    expect(
      api.createStreamingReplySection.mock.calls.some(
        (call) => call[1] === "yep_stream_artifacts",
      ),
    ).toBe(false);
    expect(api.deleteStreamingReplySection).not.toHaveBeenCalled();
    expect(api.createStreamingReplySection.mock.calls).toEqual(
      expect.arrayContaining([
        [
          "card-1",
          "yep_stream_progress",
          "### 进展",
          { type: "insert_after", targetElementId: "yep_stream_status" },
          expect.any(Number),
        ],
        [
          "card-1",
          "yep_stream_prog_01",
          "第一步完成",
          { type: "insert_after", targetElementId: "yep_stream_progress" },
          expect.any(Number),
        ],
        [
          "card-1",
          "yep_stream_prog_02",
          "第二步完成",
          { type: "insert_after", targetElementId: "yep_stream_prog_01" },
          expect.any(Number),
        ],
        [
          "card-1",
          "yep_stream_tools",
          "### 工具与活动",
          { type: "insert_after", targetElementId: "yep_stream_prog_02" },
          expect.any(Number),
        ],
      ]),
    );
    expect(api.updateStreamingReply).not.toHaveBeenCalled();
  });

  it("removes finished dynamic rows instead of leaving zero-width blank slots", async () => {
    const api = {
      ...makeOutboundApi(),
      updateStreamingReplySection: vi.fn(async () => undefined),
      createStreamingReplySection: vi.fn(async () => undefined),
      deleteStreamingReplySection: vi.fn(async () => undefined),
    } satisfies FeishuOutboundApi;
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-no-blank-slots",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-no-blank-slots"),
    );
    await controller.handleRuntimeEvent("message", {
      type: "system",
      subtype: "codex_native_item",
      codexThreadItemLifecycle: "started",
      codexThreadItem: {
        type: "agentMessage",
        id: "commentary-row",
        text: "处理中",
        phase: "commentary",
        status: "in_progress",
      },
    });
    await vi.waitFor(() =>
      expect(
        api.createStreamingReplySection.mock.calls.map((call) => call[1]),
      ).toEqual(
        expect.arrayContaining(["yep_stream_progress", "yep_stream_prog_01"]),
      ),
    );

    await controller.handleRuntimeEvent("message", {
      type: "system",
      subtype: "codex_native_item",
      codexThreadItemLifecycle: "completed",
      codexThreadItem: {
        type: "agentMessage",
        id: "commentary-row",
        text: "完成",
        phase: "final_answer",
        status: "completed",
      },
    });
    await vi.waitFor(() =>
      expect(
        api.deleteStreamingReplySection.mock.calls.map((call) => call[1]),
      ).toEqual(
        expect.arrayContaining(["yep_stream_prog_01", "yep_stream_progress"]),
      ),
    );
    expect(api.createStreamingReplySection.mock.calls).toContainEqual([
      "card-1",
      "yep_stream_answer",
      "### 回复\n\n完成",
      { type: "insert_after", targetElementId: "yep_stream_status" },
      expect.any(Number),
    ]);
    const allContent = [
      ...api.createStreamingReplySection.mock.calls.map((call) => call[2]),
      ...api.updateStreamingReplySection.mock.calls.map((call) => call[2]),
    ];
    expect(allContent).not.toContain("\u200B");
  });

  it("falls back once to chunked text without changing the Codex outcome", async () => {
    const api = makeOutboundApi();
    api.createStreamingReply.mockRejectedValueOnce(new Error("no permission"));
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-2",
      maxTextChars: 24,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent("message", userMessage("temp-2"));
    const answer = "abcdefghijklmnopqrstuvwxyz0123456789";
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      message: { content: answer },
    });
    await controller.handleRuntimeEvent("status", { state: "idle" });

    expect(controller.state).toBe("degraded_text");
    expect(api.createStreamingReply).toHaveBeenCalledTimes(1);
    expect(api.updateStreamingReply).not.toHaveBeenCalled();
    const sent = api.sendTextReply.mock.calls.map((call) => call[1]);
    expect(sent[0]).toContain("卡片更新不可用");
    expect(sent.slice(1).join("")).toContain(answer);
    expect(sent.slice(1).every((text) => text.length <= 24)).toBe(true);
  });

  it("rolls long answers into follow-up cards without truncating the tail", async () => {
    const api = makeOutboundApi();
    api.createStreamingReply
      .mockResolvedValueOnce({ cardId: "card-1", messageId: "msg-1" })
      .mockResolvedValueOnce({ cardId: "card-2", messageId: "msg-2" })
      .mockResolvedValueOnce({ cardId: "card-3", messageId: "msg-3" });
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-3",
      maxCardChars: 20,
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent("message", userMessage("temp-3"));
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      message: {
        content: "11111111112222222222333333333344444444445555555555",
      },
    });
    await controller.handleRuntimeEvent("status", { state: "idle" });

    expect(api.createStreamingReply).toHaveBeenCalledTimes(3);
    expect(api.finishStreamingReply).toHaveBeenCalledTimes(3);
    expect(api.createStreamingReply.mock.calls.at(-1)?.[1]).toContain(
      "5555555555",
    );
    expect(
      api.updateStreamingReply.mock.calls
        .filter((call) => call[0] === "card-1")
        .map((call) => call[2]),
    ).toEqual([1]);
  });

  it("shows waiting input and hides raw runtime errors", async () => {
    const api = makeOutboundApi();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-4",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent("message", userMessage("temp-4"));
    await controller.handleRuntimeEvent("status", {
      state: "waiting-input",
      request: { prompt: "cat /private/secret" },
    });
    expect(controller.state).toBe("waiting_input");
    await controller.handleRuntimeEvent("error", {
      message: "token=do-not-leak",
    });

    expect(controller.state).toBe("failed");
    const finalContent = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(finalContent).toContain("Codex 遇到未分类错误");
    expect(finalContent).toContain("诊断 ID：temp-4");
    expect(finalContent).not.toContain("do-not-leak");
    expect(finalContent).not.toContain("/private/secret");
  });

  it("separates commentary and rich process sections from the final answer", async () => {
    const api = makeOutboundApi();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-rich",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent("message", userMessage("temp-rich"));
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      uuid: "plan-rich",
      message: {
        content: [
          {
            type: "tool_use",
            id: "plan-rich",
            name: "UpdatePlan",
            input: {
              plan: [
                { step: "Inspect", status: "completed" },
                { step: "Verify", status: "in_progress" },
              ],
            },
          },
        ],
      },
    });
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      uuid: "commentary-rich",
      codexMessagePhase: "commentary",
      message: { content: "I am checking the regression." },
    });
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      uuid: "final-rich",
      codexMessagePhase: "final_answer",
      message: { content: "The regression is fixed." },
    });
    await controller.handleRuntimeEvent("status", { state: "idle" });

    expect(controller.text).toBe("The regression is fixed.");
    const finalContent = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(finalContent).toContain("### 计划");
    expect(finalContent).toContain("I am checking the regression.");
    expect(finalContent).toContain("### 回复");
    expect(finalContent).toContain("The regression is fixed.");
  });

  it("uploads a completed generated PNG once and blocks sensitive artifacts", async () => {
    const api = makeOutboundApi();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-generated-image",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-generated-image"),
    );
    const generated = {
      type: "system",
      subtype: "codex_native_item",
      codexThreadItemLifecycle: "completed",
      codexThreadItem: {
        type: "imageGeneration",
        id: "image-call-1",
        status: "completed",
        revisedPrompt: "Draw a blue square",
        result: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
        ]).toString("base64"),
        savedPath: "/private/work/generated.png",
      },
    };
    await controller.handleRuntimeEvent("message", generated);
    await controller.handleRuntimeEvent("message", generated);
    await controller.handleRuntimeEvent("message", {
      ...generated,
      isReplay: true,
      codexThreadItem: {
        ...generated.codexThreadItem,
        id: "image-call-replay",
      },
    });
    await controller.handleRuntimeEvent("message", {
      ...generated,
      codexThreadItem: {
        ...generated.codexThreadItem,
        id: "image-call-sensitive",
        revisedPrompt: "Render the password from .env",
      },
    });
    await controller.handleRuntimeEvent("status", { state: "idle" });

    expect(api.sendImageReply).toHaveBeenCalledTimes(1);
    expect(api.sendImageReply).toHaveBeenCalledWith(
      TARGET,
      expect.objectContaining({
        fileName: expect.stringMatching(/^codex-generated-[a-f0-9]{12}\.png$/),
        mimeType: "image/png",
        sizeBytes: 9,
        source: "codex_image_generation",
        retention: "feishu_managed",
      }),
    );
    const finalContent = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(finalContent).toContain("Codex 生成 · 飞书托管");
    expect(finalContent).toContain("可能包含敏感内容");
    expect(finalContent).not.toContain("/private/work");
    expect(finalContent).not.toContain("password");
  });

  it("reads and uploads a correlated managed file once across duplicate and replay events", async () => {
    const api = makeOutboundApi();
    const bytes = Buffer.from("%PDF-1.7\n");
    const readGeneratedArtifact = vi.fn(async () => bytes);
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-managed-file",
      throttleMs: 0,
      readGeneratedArtifact,
      getArtifactDeliveryScope: () => ({
        accountId: "account-a",
        sessionId: "session-a",
      }),
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-managed-file"),
    );
    const message = managedFileMessage(bytes.length);
    await controller.handleRuntimeEvent("message", message);
    await controller.handleRuntimeEvent("message", message);
    await controller.handleRuntimeEvent("message", {
      ...message,
      isReplay: true,
    });
    await controller.handleRuntimeEvent("status", { state: "idle" });

    expect(readGeneratedArtifact).toHaveBeenCalledTimes(1);
    expect(api.sendFileReply).toHaveBeenCalledTimes(1);
    expect(api.sendFileReply).toHaveBeenCalledWith(
      TARGET,
      expect.objectContaining({
        fileName: "report.pdf",
        mimeType: "application/pdf",
        bytes,
        source: "codex_generated_file",
        deliveryIdentity: {
          accountId: "account-a",
          sessionId: "session-a",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-call-1",
          artifactId: `ga_${"b".repeat(32)}`,
        },
      }),
    );
    const finalContent = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(finalContent).toContain("report.pdf");
    expect(finalContent).not.toContain("/api/projects");
    expect(finalContent).not.toContain("upload:");
  });

  it("fails closed on an uncorrelated manifest and uses a fixed upload failure message", async () => {
    const api = makeOutboundApi();
    const bytes = Buffer.from("%PDF-1.7\n");
    const readGeneratedArtifact = vi.fn(async () => bytes);
    api.sendFileReply.mockRejectedValueOnce(
      new Error("token=must-not-leak /private/work/report.pdf"),
    );
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-managed-failure",
      throttleMs: 0,
      readGeneratedArtifact,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-managed-failure"),
    );
    const valid = managedFileMessage(bytes.length);
    await controller.handleRuntimeEvent("message", {
      ...valid,
      codexGeneratedArtifacts: [
        {
          ...valid.codexGeneratedArtifacts[0],
          id: `ga_${"c".repeat(32)}`,
          source: {
            ...valid.codexGeneratedArtifacts[0].source,
            turnId: "forged-turn",
          },
        },
      ],
    });
    expect(readGeneratedArtifact).not.toHaveBeenCalled();

    await controller.handleRuntimeEvent("message", valid);
    await controller.handleRuntimeEvent("status", { state: "idle" });
    expect(readGeneratedArtifact).toHaveBeenCalledTimes(1);
    expect(api.sendFileReply).toHaveBeenCalledTimes(1);
    const finalContent = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(finalContent).toContain("生成物上传飞书失败");
    expect(finalContent).not.toContain("must-not-leak");
    expect(finalContent).not.toContain("/private/work");
  });

  it("marks a generated-artifact effect complete only after a successful retry", async () => {
    const api = makeOutboundApi();
    const bytes = Buffer.from("%PDF-1.7\n");
    api.sendFileReply
      .mockRejectedValueOnce(new Error("temporary upload failure"))
      .mockResolvedValueOnce({
        messageId: "msg-file-retry",
        fileKey: "file-retry",
      });
    const readGeneratedArtifact = vi.fn(async () => bytes);
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-managed-retry",
      throttleMs: 0,
      readGeneratedArtifact,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-managed-retry"),
    );
    const message = managedFileMessage(bytes.length);

    await controller.handleRuntimeEvent("message", message);
    await controller.handleRuntimeEvent("message", message);
    await controller.handleRuntimeEvent("message", message);

    expect(readGeneratedArtifact).toHaveBeenCalledTimes(2);
    expect(api.sendFileReply).toHaveBeenCalledTimes(2);
  });

  it("revalidates a managed copy before outbound upload", async () => {
    const api = makeOutboundApi();
    const tampered = Buffer.from("api_key=fixture-sensitive-value\n");
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-managed-tamper",
      throttleMs: 0,
      readGeneratedArtifact: vi.fn(async () => tampered),
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-managed-tamper"),
    );
    const message = managedFileMessage(tampered.length);
    await controller.handleRuntimeEvent("message", {
      ...message,
      codexGeneratedArtifacts: [
        {
          ...message.codexGeneratedArtifacts[0],
          fileName: "notes.txt",
          kind: "text",
          mimeType: "text/plain",
          downloadUrl: `/api/projects/project/sessions/session/generated-artifact/${message.codexGeneratedArtifacts[0].id}/${message.codexGeneratedArtifacts[0].sha256.slice("sha256:".length)}/notes.txt`,
        },
      ],
    });
    await controller.handleRuntimeEvent("status", { state: "idle" });

    expect(api.sendFileReply).not.toHaveBeenCalled();
    const finalContent = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(finalContent).toContain("生成物载荷无效");
    expect(finalContent).not.toContain("fixture-sensitive-value");
  });

  it("settles a provider error that arrives before the matching user echo", async () => {
    const api = makeOutboundApi();
    const terminal = vi.fn();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-early-error",
      throttleMs: 0,
      onTerminal: terminal,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();

    await controller.handleRuntimeEvent("error", {
      message: "no rollout found for thread",
    });

    expect(controller.state).toBe("failed");
    expect(terminal).toHaveBeenCalledWith("failed", "failed");
    expect(api.updateStreamingReply.mock.calls.at(-1)?.[1]).toContain(
      "当前会话尚未准备好",
    );
    expect(api.updateStreamingReply.mock.calls.at(-1)?.[1]).toContain(
      "CODEX_NO_ROLLOUT（no_rollout）",
    );
    expect(api.updateStreamingReply.mock.calls.at(-1)?.[1]).toContain(
      "可重试：是",
    );
  });

  it("localizes a canonical code without trusting provider display strings", async () => {
    const api = makeOutboundApi();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-safe-canonical-error",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-safe-canonical-error"),
    );
    await controller.handleRuntimeEvent("message", {
      type: "error",
      turnId: "turn-1",
      codexError: {
        code: "CODEX_AUTH_REQUIRED",
        category: "auth",
        retryable: false,
        publicMessage: "synthetic-sensitive-provider-detail",
        nextAction: "synthetic-private-provider-action",
      },
    });

    const content = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(content).toContain("Codex 登录状态已失效或尚未完成");
    expect(content).toContain("CODEX_AUTH_REQUIRED（auth）");
    expect(content).not.toContain("synthetic-sensitive-provider-detail");
    expect(content).not.toContain("synthetic-private-provider-action");
  });

  it("replays an SDK error that races ahead of dispatch confirmation", async () => {
    const api = makeOutboundApi();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-racing-error",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();

    await controller.handleRuntimeEvent("message", {
      type: "error",
      error: "private runtime detail",
    });
    expect(controller.state).toBe("acknowledged");

    controller.dispatchAccepted();
    await controller.handleRuntimeEvent("connected", undefined);

    expect(controller.state).toBe("failed");
    const finalContent = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(finalContent).toContain("Codex 遇到未分类错误");
    expect(finalContent).not.toContain("private runtime detail");
  });

  it("treats completion without a matching user echo as a failed dispatch", async () => {
    const controller = new FeishuReplyController({
      target: TARGET,
      replyMode: "card",
      tempId: "temp-early-complete",
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();

    await controller.handleRuntimeEvent("complete", undefined);

    expect(controller.state).toBe("failed");
    expect(controller.text).toContain("Codex 遇到未分类错误");
  });

  it.each([
    ["is_error", { type: "result", turnId: "turn-1", is_error: true }],
    [
      "error subtype",
      {
        type: "result",
        turnId: "turn-1",
        subtype: "error_during_execution",
      },
    ],
  ])(
    "accepts a matching failed provider result via %s exactly once",
    async (_label, result) => {
      const terminal = vi.fn();
      const controller = new FeishuReplyController({
        target: TARGET,
        replyMode: "card",
        tempId: "temp-provider-result",
        onTerminal: terminal,
      });
      controllers.push(controller);
      await controller.start();
      controller.dispatchAccepted();

      // A result without this turn's user echo is not correlated evidence.
      await controller.handleRuntimeEvent("message", {
        type: "result",
        turnId: "turn-older",
        session_id: "older-session",
      });
      expect(controller.state).toBe("acknowledged");

      await controller.handleRuntimeEvent(
        "message",
        userMessage("temp-provider-result"),
      );
      await controller.handleRuntimeEvent("message", result);
      await controller.handleRuntimeEvent("status", { state: "idle" });
      await controller.handleRuntimeEvent("complete", undefined);

      expect(controller.state).toBe("failed");
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(terminal).toHaveBeenCalledWith("failed", "failed");
    },
  );

  it("settles an authoritative turn terminal that races ahead of the user echo", async () => {
    const terminal = vi.fn();
    const controller = new FeishuReplyController({
      target: TARGET,
      replyMode: "card",
      tempId: "temp-early-turn-terminal",
      onTerminal: terminal,
    });
    controllers.push(controller);
    await controller.start();

    await controller.handleRuntimeEvent("message", {
      type: "system",
      subtype: "turn_complete",
      turnId: "turn-early",
      turnStatus: "interrupted",
    });
    expect(controller.state).toBe("acknowledged");

    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-early-turn-terminal", "turn-early"),
    );

    expect(controller.state).toBe("interrupted");
    expect(terminal).toHaveBeenCalledWith("interrupted", "interrupted");
  });

  it("does not attribute the old turn terminal to an optimistic queued message", async () => {
    const terminal = vi.fn();
    const controller = new FeishuReplyController({
      target: TARGET,
      replyMode: "card",
      tempId: "temp-queued-b",
      onTerminal: terminal,
    });
    controllers.push(controller);
    await controller.start();

    await controller.handleRuntimeEvent("message", {
      type: "user",
      tempId: "temp-queued-b",
      uuid: "client-temp-queued-b",
      clientUserMessageId: "client-temp-queued-b",
      isOptimistic: true,
      message: { content: "queued B" },
    });
    await controller.handleRuntimeEvent("message", {
      type: "result",
      turnId: "turn-a",
      clientUserMessageId: "client-a",
    });
    await controller.handleRuntimeEvent("status", { state: "idle" });

    controller.dispatchAccepted();
    await controller.handleRuntimeEvent("connected", undefined);
    expect(controller.state).toBe("acknowledged");
    expect(terminal).not.toHaveBeenCalled();

    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-queued-b", "turn-b"),
    );
    expect(controller.state).toBe("streaming");
    await controller.handleRuntimeEvent("message", {
      type: "system",
      subtype: "turn_complete",
      turnId: "turn-b",
      turnStatus: "completed",
    });

    expect(controller.state).toBe("completed");
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledWith("completed", "completed");
  });

  it("ignores a prior-turn tool lifecycle and closes the current Bash on interruption", async () => {
    const api = makeOutboundApi();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-s4",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("temp-s4", "turn-s4"),
    );

    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      turnId: "turn-s3",
      codexTurnId: "turn-s3",
      message: {
        content: [{ type: "tool_use", id: "bash-s3", name: "Bash", input: {} }],
      },
    });
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      turnId: "turn-s4",
      codexTurnId: "turn-s4",
      message: {
        content: [{ type: "tool_use", id: "bash-s4", name: "Bash", input: {} }],
      },
    });
    await controller.handleRuntimeEvent("message", {
      type: "user",
      turnId: "turn-s4",
      codexTurnId: "turn-s4",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "bash-s4",
            content: "declined",
            is_error: true,
          },
        ],
      },
    });
    await controller.handleRuntimeEvent("message", {
      type: "system",
      subtype: "turn_complete",
      turnId: "turn-s4",
      turnStatus: "interrupted",
    });

    const finalContent = api.updateStreamingReply.mock.calls.at(-1)?.[1] ?? "";
    expect(finalContent.match(/Bash ·/g)).toHaveLength(1);
    expect(finalContent).toContain("Bash · 失败");
    expect(finalContent).not.toContain("Bash · 进行中");
    expect(controller.state).toBe("interrupted");
  });

  it("does not let a replayed terminal close a newly accepted reply", async () => {
    const controller = new FeishuReplyController({
      target: TARGET,
      replyMode: "card",
      tempId: "temp-replayed-turn-terminal",
    });
    controllers.push(controller);
    await controller.start();

    await controller.handleRuntimeEvent("message", {
      type: "system",
      subtype: "turn_complete",
      turnStatus: "completed",
      isReplay: true,
    });
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent("connected", undefined);

    expect(controller.state).toBe("acknowledged");
  });

  it("buffers safe queued/retrying feedback before dispatch confirmation", async () => {
    const api = makeOutboundApi();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "temp-retry",
      throttleMs: 0,
    });
    controllers.push(controller);
    await controller.start();

    await controller.handleRuntimeEvent("message", retryWarning("queued", 1));
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent("connected", undefined);
    expect(controller.state).toBe("queued");

    await controller.handleRuntimeEvent("message", retryWarning("retrying", 2));
    expect(controller.state).toBe("retrying");
    await vi.waitFor(() => expect(api.updateStreamingReply).toHaveBeenCalled());
    const content = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(content).toContain("正在自动重试（3/4）");
    expect(content).not.toContain("Server overloaded");
    expect(content).not.toContain("raw-token");
    expect(content).not.toContain("-32001");
  });

  it("adds a safe Yep link and partial-result flag to a failed card", async () => {
    const api = makeOutboundApi();
    const controller = new FeishuReplyController({
      api,
      target: TARGET,
      replyMode: "card",
      tempId: "feishu-0123456789abcdef0123456789abcdef",
      throttleMs: 0,
      getYepDeepLink: () => ({
        state: "available",
        url: "https://yep.example.com/yep/sessions/feishu-0123456789abcdef0123456789abcdef",
      }),
    });
    controllers.push(controller);
    await controller.start();
    controller.dispatchAccepted();
    await controller.handleRuntimeEvent(
      "message",
      userMessage("feishu-0123456789abcdef0123456789abcdef"),
    );
    await controller.handleRuntimeEvent("message", {
      type: "assistant",
      message: { content: "partial answer" },
    });
    await controller.handleRuntimeEvent("error", {
      message: "token=must-not-leak /private/project",
    });

    const content = api.updateStreamingReply.mock.calls.at(-1)?.[1];
    expect(content).toContain("已有部分结果：是");
    expect(content).toContain(
      "[在 Yep 查看](https://yep.example.com/yep/sessions/",
    );
    expect(content).not.toContain("must-not-leak");
    expect(content).not.toContain("/private/project");
  });
});

const TARGET: FeishuStreamingReplyTarget = {
  chatId: "oc_chat",
  replyToMessageId: "om_inbound",
  replyInThread: true,
};

function makeOutboundApi() {
  return {
    createStreamingReply: vi.fn(async () => ({
      cardId: "card-1",
      messageId: "msg-1",
    })),
    updateStreamingReply: vi.fn(async () => undefined),
    finishStreamingReply: vi.fn(async () => undefined),
    sendTextReply: vi.fn(async () => ({ messageId: "msg-text" })),
    sendImageReply: vi.fn(async () => ({
      messageId: "msg-image",
      imageKey: "img-generated",
    })),
    sendFileReply: vi.fn(async () => ({
      messageId: "msg-file",
      fileKey: "file-generated",
    })),
    sendVideoReply: vi.fn(async () => ({
      messageId: "msg-video",
      fileKey: "video-generated",
    })),
  } satisfies FeishuOutboundApi;
}

function managedFileMessage(sizeBytes: number) {
  const id = `ga_${"b".repeat(32)}`;
  const sha256 = `sha256:${createHash("sha256")
    .update(Buffer.from("%PDF-1.7\n"))
    .digest("hex")}`;
  return {
    type: "system",
    subtype: "codex_native_item",
    codexThreadItemLifecycle: "completed",
    codexThreadId: "thread-1",
    codexTurnId: "turn-1",
    codexThreadItem: {
      type: "fileChange",
      id: "file-call-1",
      status: "completed",
      changes: [{ path: "report.pdf", kind: { type: "add" } }],
    },
    codexGeneratedArtifacts: [
      {
        schemaVersion: 1,
        id,
        managedRef: "upload:123e4567-e89b-12d3-a456-426614174000",
        fileName: "report.pdf",
        kind: "document",
        mimeType: "application/pdf",
        sizeBytes,
        sha256,
        source: {
          provider: "codex",
          type: "file_change",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "file-call-1",
        },
        retention: {
          policy: "temporary",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        downloadUrl: `/api/projects/project/sessions/session/generated-artifact/${id}/${sha256.slice("sha256:".length)}/report.pdf`,
      },
    ],
  };
}

function streamDelta(text: string): unknown {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  };
}

function userMessage(tempId: string, turnId = "turn-1"): unknown {
  const clientUserMessageId = `client-${tempId}`;
  return {
    type: "user",
    tempId,
    uuid: clientUserMessageId,
    clientUserMessageId,
    turnId,
    codexTurnId: turnId,
    message: { content: "prompt" },
  };
}

function retryWarning(state: "queued" | "retrying", attempt: number): unknown {
  return {
    type: "system",
    subtype: "warning",
    content: "Server overloaded; retry later. raw-token -32001",
    codexRetryStatus: {
      state,
      category: "overloaded",
      retryable: true,
      attempt,
      nextAttempt: attempt + 1,
      maxAttempts: 4,
      retryInMs: 50 * 2 ** (attempt - 1),
    },
  };
}
