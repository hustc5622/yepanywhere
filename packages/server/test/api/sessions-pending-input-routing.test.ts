import type { InputRequest, UserQuestionAnswers } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type {
  BridgeInputResponse,
  BridgeSessionView,
} from "../../src/bridge-common/types.js";
import type { OpenCodeBridgeController } from "../../src/opencode-bridge/types.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createSessionsRoutes } from "../../src/routes/sessions.js";
import type {
  RuntimeController,
  RuntimeInputResponseRequest,
  RuntimePermissionModeRequest,
  RuntimeProcessSnapshot,
} from "../../src/runtime/types.js";
import type { ISessionReader } from "../../src/sessions/types.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";

const SESSION_ID = "ses_059c6c7dfffeY9me6Efa0cXTVR";

function toolApproval(id: string): InputRequest {
  return {
    id,
    type: "tool-approval",
    prompt: "Allow external_directory /tmp/mws2/*?",
    toolName: "bash",
  } as InputRequest;
}

function question(id: string): InputRequest {
  return {
    id,
    type: "question",
    prompt: "Choose an option",
  } as InputRequest;
}

function processSnapshot(
  pendingInputRequest: InputRequest | null,
): RuntimeProcessSnapshot {
  return {
    id: "proc-1",
    sessionId: SESSION_ID,
    projectId: "p1",
    projectPath: "/repo/app",
    projectName: "app",
    sessionTitle: null,
    state: "waiting-input",
    startedAt: new Date(0).toISOString(),
    queueDepth: 0,
    provider: "opencode",
    permissionMode: "default",
    modeVersion: 0,
    pendingInputRequest,
    messageHistory: [],
    supportsDynamicModels: false,
    supportsDynamicCommands: false,
    supportsSetModel: false,
  } as unknown as RuntimeProcessSnapshot;
}

interface Harness {
  routes: ReturnType<typeof createSessionsRoutes>;
  calls: {
    runtimeRespond: RuntimeInputResponseRequest[];
    bridgeRespond: Array<{
      sessionId: string;
      requestId: string;
      response: BridgeInputResponse;
      answers?: UserQuestionAnswers;
    }>;
    permissionMode: RuntimePermissionModeRequest[];
  };
  /** Pending requests still held after the exchange. */
  remaining: () => {
    process: InputRequest | null;
    bridge: InputRequest | null;
  };
}

function harness(options: {
  /** `null` means "Yep owns no process for this session". */
  processPending?: InputRequest | null | undefined;
  hasProcess?: boolean;
  bridgePending?: InputRequest | null;
  /** Simulate the runtime rejecting a stale requestId. */
  runtimeAccepts?: boolean;
}): Harness {
  const hasProcess = options.hasProcess ?? true;
  let processPending = options.processPending ?? null;
  let bridgePending = options.bridgePending ?? null;

  const calls: Harness["calls"] = {
    runtimeRespond: [],
    bridgeRespond: [],
    permissionMode: [],
  };

  const runtimeController = {
    getProcessSnapshotForSession: async () =>
      hasProcess ? processSnapshot(processPending) : null,
    getPendingInputRequest: async () => {
      throw new Error(
        "pending-input must be served from the process snapshot, not a second runtime round-trip",
      );
    },
    respondToInput: async (input: RuntimeInputResponseRequest) => {
      calls.runtimeRespond.push(input);
      if (options.runtimeAccepts === false) return { accepted: false };
      if (processPending?.id !== input.requestId) return { accepted: false };
      processPending = null;
      return { accepted: true };
    },
    setPermissionMode: async (input: RuntimePermissionModeRequest) => {
      calls.permissionMode.push(input);
      return { ok: true, permissionMode: input.mode, modeVersion: 1 };
    },
  } as unknown as RuntimeController;

  const opencodeBridgeService = {
    getStatus: () => {
      throw new Error("getStatus must not be called by these routes");
    },
    listSessions: () => [],
    listSessionViews: () => [] as BridgeSessionView[],
    getSessionView: () => null,
    isSessionActive: () => false,
    getPendingInputRequest: (sessionId: string) =>
      sessionId === SESSION_ID ? bridgePending : null,
    respondToInput: async (
      sessionId: string,
      requestId: string,
      response: BridgeInputResponse,
      answers?: UserQuestionAnswers,
    ) => {
      calls.bridgeRespond.push({ sessionId, requestId, response, answers });
      if (bridgePending?.id !== requestId) return false;
      bridgePending = null;
      return true;
    },
  } as unknown as OpenCodeBridgeController;

  const routes = createSessionsRoutes({
    runtimeController,
    supervisor: {} as unknown as Supervisor,
    scanner: {
      getOrCreateProject: async () => null,
      listProjects: async () => [],
      invalidateCache: () => {},
    } as unknown as ProjectScanner,
    readerFactory: () => ({}) as unknown as ISessionReader,
    opencodeBridgeService,
  });

  return {
    routes,
    calls,
    remaining: () => ({ process: processPending, bridge: bridgePending }),
  };
}

function postInput(
  h: Harness,
  body: Record<string, unknown>,
): Promise<Response> {
  return h.routes.request(`/sessions/${SESSION_ID}/input`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Yep-Anywhere": "true",
    },
    body: JSON.stringify(body),
  });
}

describe("pending input owner routing", () => {
  const BRIDGE_REQUEST_ID = "per_fa77702a2001lr0HLLVceagCDl";

  it("serves a bridge-held request from GET pending-input while a process is owned", async () => {
    const h = harness({
      processPending: null,
      bridgePending: toolApproval(BRIDGE_REQUEST_ID),
    });

    const res = await h.routes.request(`/sessions/${SESSION_ID}/pending-input`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      request: {
        id: BRIDGE_REQUEST_ID,
        type: "tool-approval",
        interaction: {
          operationId: expect.stringMatching(/^int_/u),
          requestId: BRIDGE_REQUEST_ID,
          sessionId: SESSION_ID,
          state: "open",
          version: 0,
        },
      },
    });
  });

  it("submits a bridge-held requestId even though a Yep process owns the session", async () => {
    const h = harness({
      processPending: null,
      bridgePending: toolApproval(BRIDGE_REQUEST_ID),
    });

    const res = await postInput(h, {
      requestId: BRIDGE_REQUEST_ID,
      response: "approve",
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ accepted: true });
    expect(h.calls.bridgeRespond).toEqual([
      {
        sessionId: SESSION_ID,
        requestId: BRIDGE_REQUEST_ID,
        response: "approve",
        answers: undefined,
      },
    ]);
    expect(h.calls.runtimeRespond).toEqual([]);
    // The request is consumed, so a refetch cannot resurrect the popup.
    expect(h.remaining().bridge).toBeNull();
  });

  it("routes each side's own requestId to its owner", async () => {
    const processRequest = toolApproval("req-process");
    const bridgeRequest = toolApproval("req-bridge");

    const processHarness = harness({
      processPending: processRequest,
      bridgePending: bridgeRequest,
    });
    await expect(
      postInput(processHarness, {
        requestId: "req-process",
        response: "approve",
      }).then((r) => r.status),
    ).resolves.toBe(200);
    expect(processHarness.calls.runtimeRespond).toHaveLength(1);
    expect(processHarness.calls.bridgeRespond).toEqual([]);

    const bridgeHarness = harness({
      processPending: processRequest,
      bridgePending: bridgeRequest,
    });
    await expect(
      postInput(bridgeHarness, {
        requestId: "req-bridge",
        response: "approve",
      }).then((r) => r.status),
    ).resolves.toBe(200);
    expect(bridgeHarness.calls.bridgeRespond).toHaveLength(1);
    expect(bridgeHarness.calls.runtimeRespond).toEqual([]);
  });

  it("submits a shared requestId exactly once, with the process winning", async () => {
    const shared = toolApproval("req-shared");
    const h = harness({ processPending: shared, bridgePending: shared });

    const res = await postInput(h, {
      requestId: "req-shared",
      response: "approve",
    });

    expect(res.status).toBe(200);
    expect(h.calls.runtimeRespond).toHaveLength(1);
    expect(h.calls.bridgeRespond).toEqual([]);
  });

  it("rejects an unknown requestId without consuming either side", async () => {
    const processRequest = toolApproval("req-process");
    const bridgeRequest = toolApproval("req-bridge");
    const h = harness({
      processPending: processRequest,
      bridgePending: bridgeRequest,
    });

    const res = await postInput(h, {
      requestId: "req-unknown",
      response: "approve",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Invalid request ID or no pending request",
    });
    expect(h.calls.runtimeRespond).toEqual([]);
    expect(h.calls.bridgeRespond).toEqual([]);
    expect(h.remaining()).toEqual({
      process: processRequest,
      bridge: bridgeRequest,
    });
  });

  it("keeps a bridge question pending when required answers are missing", async () => {
    const bridgeRequest = question("que_1");
    const h = harness({ processPending: null, bridgePending: bridgeRequest });

    const res = await postInput(h, {
      requestId: "que_1",
      response: "approve",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Question response is missing 1 required answer",
    });
    expect(h.calls.bridgeRespond).toEqual([]);
    expect(h.remaining().bridge).toBe(bridgeRequest);
  });

  it("forwards approve_always to the bridge verbatim for a native `always` reply", async () => {
    const h = harness({
      processPending: null,
      bridgePending: toolApproval(BRIDGE_REQUEST_ID),
    });

    const res = await postInput(h, {
      requestId: BRIDGE_REQUEST_ID,
      response: "approve_always",
    });

    expect(res.status).toBe(200);
    expect(h.calls.bridgeRespond[0]?.response).toBe("approve_always");
  });

  it("switches the owned process to acceptEdits after a bridge approve_accept_edits", async () => {
    const h = harness({
      processPending: null,
      bridgePending: toolApproval(BRIDGE_REQUEST_ID),
    });

    const res = await postInput(h, {
      requestId: BRIDGE_REQUEST_ID,
      response: "approve_accept_edits",
    });

    expect(res.status).toBe(200);
    expect(h.calls.bridgeRespond[0]?.response).toBe("approve_accept_edits");
    expect(h.calls.permissionMode).toEqual([
      { sessionId: SESSION_ID, mode: "acceptEdits" },
    ]);
  });

  it("maps deny for a bridge-held request", async () => {
    const h = harness({
      processPending: null,
      bridgePending: toolApproval(BRIDGE_REQUEST_ID),
    });

    const res = await postInput(h, {
      requestId: BRIDGE_REQUEST_ID,
      response: "deny",
    });

    expect(res.status).toBe(200);
    expect(h.calls.bridgeRespond[0]?.response).toBe("deny");
    expect(h.calls.permissionMode).toEqual([]);
  });

  it("still serves and submits a pure bridge session with no process", async () => {
    const h = harness({
      hasProcess: false,
      bridgePending: toolApproval(BRIDGE_REQUEST_ID),
    });

    await expect(
      h.routes
        .request(`/sessions/${SESSION_ID}/pending-input`)
        .then((r) => r.json()),
    ).resolves.toMatchObject({ request: { id: BRIDGE_REQUEST_ID } });

    const res = await postInput(h, {
      requestId: BRIDGE_REQUEST_ID,
      response: "approve",
    });
    expect(res.status).toBe(200);
    expect(h.calls.bridgeRespond).toHaveLength(1);
    // No process exists, so no pointless runtime mode round-trip.
    expect(h.calls.permissionMode).toEqual([]);
  });

  it("returns 404 when neither a process nor a bridge holds the session", async () => {
    const h = harness({ hasProcess: false, bridgePending: null });

    const res = await postInput(h, {
      requestId: "req-gone",
      response: "approve",
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "No active process for session",
    });
    expect(h.calls.bridgeRespond).toEqual([]);
  });

  it("keeps the process approval path intact, including acceptEdits", async () => {
    const h = harness({
      processPending: toolApproval("req-process"),
      bridgePending: null,
    });

    const res = await postInput(h, {
      requestId: "req-process",
      response: "approve_accept_edits",
    });

    expect(res.status).toBe(200);
    expect(h.calls.runtimeRespond).toEqual([
      {
        sessionId: SESSION_ID,
        requestId: "req-process",
        response: "approve",
        answers: undefined,
        feedback: undefined,
      },
    ]);
    expect(h.calls.permissionMode).toEqual([
      { sessionId: SESSION_ID, mode: "acceptEdits" },
    ]);
  });

  it("reports a stale process requestId the runtime refuses as a 400", async () => {
    const h = harness({
      processPending: toolApproval("req-process"),
      bridgePending: null,
      runtimeAccepts: false,
    });

    const res = await postInput(h, {
      requestId: "req-process",
      response: "approve",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Invalid request ID or no pending request",
    });
    expect(h.calls.permissionMode).toEqual([]);
  });

  it("validates the body before looking up any owner", async () => {
    const h = harness({
      processPending: null,
      bridgePending: toolApproval(BRIDGE_REQUEST_ID),
    });

    const missing = await postInput(h, { response: "approve" });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({
      error: "requestId and response are required",
    });

    const invalid = await h.routes.request(`/sessions/${SESSION_ID}/input`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Yep-Anywhere": "true",
      },
      body: "not json",
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      error: "Invalid JSON body",
    });

    expect(h.calls.bridgeRespond).toEqual([]);
    expect(h.calls.runtimeRespond).toEqual([]);
  });

  it("rejects a partial broker identity before invoking either owner", async () => {
    const h = harness({
      processPending: null,
      bridgePending: toolApproval(BRIDGE_REQUEST_ID),
    });

    const res = await postInput(h, {
      requestId: BRIDGE_REQUEST_ID,
      response: "approve",
      operationId: "int_12345678-1234-4234-8234-123456789abc",
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "operationId and operationVersion must be provided together",
      code: "interaction_identity_incomplete",
    });
    expect(h.calls.bridgeRespond).toEqual([]);
    expect(h.calls.runtimeRespond).toEqual([]);
  });

  it("rejects malformed untrusted identity fields without throwing", async () => {
    const h = harness({
      processPending: null,
      bridgePending: toolApproval(BRIDGE_REQUEST_ID),
    });

    const res = await postInput(h, {
      requestId: BRIDGE_REQUEST_ID,
      response: "approve",
      operationId: 7,
      operationVersion: 0,
      actor: { id: 42, channel: "feishu" },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Interaction identity is invalid",
      code: "interaction_identity_invalid",
    });
    expect(h.calls.bridgeRespond).toEqual([]);
    expect(h.calls.runtimeRespond).toEqual([]);
  });
});
