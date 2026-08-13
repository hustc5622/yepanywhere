/**
 * ACP Client wrapper for Agent Client Protocol connections.
 *
 * Provides a reusable client for spawning and communicating with ACP agents
 * (Gemini, Codex, OpenCode, etc.) over JSON-RPC/stdio.
 *
 * Gemini uses a hybrid model where it executes its own tools internally,
 * but asks for permission on sensitive operations (file writes, shell commands).
 * This client handles those permission requests via a callback mechanism.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  type Agent,
  type Client,
  type ClientCapabilities,
  ClientSideConnection,
  type ContentBlock,
  type InitializeResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionResponse,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { getLogger } from "../../../logging/logger.js";

/**
 * Configuration for spawning an ACP agent.
 */
export interface ACPClientConfig {
  /** Command to spawn (e.g., "gemini", "codex-acp") */
  command: string;
  /** Command arguments (e.g., ["--experimental-acp"]) */
  args?: string[];
  /** Working directory for the agent process */
  cwd: string;
  /** Additional environment variables */
  env?: Record<string, string>;
}

/**
 * Callback for session update notifications from the agent.
 */
export type SessionUpdateCallback = (update: SessionNotification) => void;

/**
 * Callback for permission requests from the agent.
 * The callback should surface the request to UI and wait for user response.
 * Returns a promise that resolves with the user's decision.
 */
export type PermissionRequestCallback = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

/**
 * ACP Client - manages connection to an ACP-compatible agent.
 *
 * Usage:
 * ```typescript
 * const client = new ACPClient();
 * await client.connect({ command: 'gemini', args: ['--experimental-acp'], cwd: '/path' });
 * const init = await client.initialize();
 * const sessionId = await client.newSession('/path');
 * const result = await client.prompt(sessionId, 'Hello!');
 * client.close();
 * ```
 */
export class ACPClient {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private log = getLogger();

  /** OS PID of the spawned ACP agent child process */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Whether the spawned ACP agent child process is still running.
   *
   * Mirrors the liveness signal used by the codex/claude/opencode providers
   * (the Node ChildProcess exit state). The supervisor's stale-process
   * watchdog uses this to distinguish "process died silently" from "process
   * is busy with a long-running turn" — e.g. Kimi orchestrating AgentSwarm /
   * explore subagents keeps the parent ACP prompt silent for minutes while
   * the child process is very much alive. Without this, the watchdog falls
   * back to a time-based heuristic and kills the healthy process.
   */
  isAlive(): boolean {
    const child = this.process;
    return Boolean(
      child?.pid &&
        child.exitCode === null &&
        child.signalCode === null &&
        !child.killed,
    );
  }
  private onSessionUpdate: SessionUpdateCallback | null = null;
  private onPermissionRequest: PermissionRequestCallback | null = null;

  /**
   * Set callback for session update notifications.
   * Must be called before connect() to receive all updates.
   */
  setSessionUpdateCallback(callback: SessionUpdateCallback): void {
    this.onSessionUpdate = callback;
  }

  /**
   * Set callback for permission requests.
   * The callback should surface the request to UI and wait for user response.
   * Must be called before sending prompts to receive permission requests.
   */
  setPermissionRequestCallback(callback: PermissionRequestCallback): void {
    this.log.debug("Permission request callback registered");
    this.onPermissionRequest = callback;
  }

  /**
   * Connect to an ACP agent by spawning it as a subprocess.
   */
  async connect(config: ACPClientConfig): Promise<void> {
    this.log.debug(
      { command: config.command, args: config.args },
      "Spawning ACP agent",
    );

    this.process = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
      shell: process.platform === "win32",
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const stderr = data.toString().trim();
      if (stderr) {
        this.log.debug({ stderr }, "ACP agent stderr");
      }
    });

    this.process.on("error", (err) => {
      this.log.error({ err }, "ACP agent process error");
    });

    this.process.on("exit", (code, signal) => {
      this.log.debug({ code, signal }, "ACP agent process exited");
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error("Failed to get stdin/stdout from spawned ACP process");
    }

    // Create the NDJSON stream for ACP protocol
    const stream = ndJsonStream(
      Writable.toWeb(this.process.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.process.stdout) as ReadableStream<Uint8Array>,
    );

    // Create client handlers
    const createClient = (_agent: Agent): Client => this.createClientHandlers();

    this.connection = new ClientSideConnection(createClient, stream);
  }

  /**
   * Create client-side handlers for ACP protocol.
   * Handles session updates and permission requests.
   */
  private createClientHandlers(): Client {
    this.log.debug(
      { hasPermissionCallback: !!this.onPermissionRequest },
      "Creating ACP client handlers",
    );
    return {
      sessionUpdate: async (params: SessionNotification) => {
        this.log.trace({ update: params }, "ACP session update");
        this.onSessionUpdate?.(params);
      },
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        this.log.debug({ params }, "ACP permission request received");

        if (this.onPermissionRequest) {
          // Wait for user to decide - no timeout, waits for user response
          return this.onPermissionRequest(params);
        }

        // No handler configured - deny by default
        this.log.warn("No permission handler configured, cancelling");
        return { outcome: { outcome: "cancelled" } };
      },
    };
  }

  /**
   * Initialize the ACP connection.
   * Must be called after connect() and before newSession().
   *
   * The returned `agentCapabilities` describes what the agent's ACP layer can
   * ingest (e.g. `promptCapabilities.image`). Note that it reflects the
   * adapter, not the currently selected model — Kimi advertises
   * `image: true` unconditionally and drops images later if the resolved model
   * lacks the `image_in` capability.
   */
  async initialize(
    capabilities: ClientCapabilities = {},
  ): Promise<InitializeResponse> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ capabilities }, "Initializing ACP connection");

    const result = await this.connection.initialize({
      protocolVersion: 1,
      clientInfo: {
        name: "yepanywhere",
        version: "1.0.0",
      },
      clientCapabilities: capabilities,
    });

    this.log.debug({ result }, "ACP initialization complete");
    return result;
  }

  /**
   * Create a new session with the agent.
   * Returns the session ID.
   */
  async newSession(cwd: string): Promise<string> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ cwd }, "Creating new ACP session");

    const result = await this.connection.newSession({
      cwd,
      mcpServers: [],
    });

    this.log.debug({ sessionId: result.sessionId }, "ACP session created");
    return result.sessionId;
  }

  /**
   * Load an existing session by ID.
   * Note: This uses session/load which may not be supported by all agents.
   */
  async loadSession(sessionId: string, cwd: string): Promise<void> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ sessionId, cwd }, "Loading existing ACP session");

    await this.connection.loadSession({
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  /**
   * Resume an existing session by ID.
   * Uses session/resume, which may be supported even when session/load is not.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<string> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ sessionId, cwd }, "Resuming existing ACP session");

    const result = await this.connection.resumeSession({
      sessionId,
      cwd,
      mcpServers: [],
    });

    this.log.debug({ result }, "ACP session resumed");
    return sessionId;
  }

  /**
   * Change the agent-native mode for an active ACP session.
   *
   * Kimi advertises `default`, `plan`, `auto`, and `yolo` while retaining the
   * standard `session/set_mode` endpoint for ACP clients.
   */
  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug({ sessionId, modeId }, "Setting ACP session mode");
    await this.connection.setSessionMode({ sessionId, modeId });
  }

  /**
   * Set a select-valued configuration option for an active ACP session.
   *
   * Kimi exposes its model-specific thinking effort through the standard
   * `thinking` config option (`category: "thought_level"`). The full response
   * is returned so callers can verify that the agent accepted, rather than
   * silently clamped, the requested value.
   */
  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    this.log.debug(
      { sessionId, configId, value },
      "Setting ACP session config option",
    );
    return this.connection.setSessionConfigOption({
      sessionId,
      configId,
      value,
    });
  }

  /**
   * Send a prompt to the agent and get a response.
   *
   * Accepts either a plain string (wrapped into a single `text` block) or a
   * pre-built `ContentBlock[]` for multimodal prompts. Agents that advertise
   * `promptCapabilities.image` / `.embeddedContext` consume `image` and
   * `resource_link` blocks natively; a file path embedded in prompt text does
   * not put the bytes in front of the model.
   *
   * Note: this is a simple request/response pattern. Session updates are
   * delivered via the callback set with setSessionUpdateCallback().
   */
  async prompt(
    sessionId: string,
    content: string | readonly ContentBlock[],
  ): Promise<PromptResponse> {
    if (!this.connection) {
      throw new Error("ACPClient not connected. Call connect() first.");
    }

    const blocks: ContentBlock[] =
      typeof content === "string"
        ? [{ type: "text", text: content }]
        : [...content];

    this.log.debug(
      {
        sessionId,
        blockCount: blocks.length,
        blockTypes: blocks.map((b) => b.type),
        textLength: blocks.reduce(
          (n, b) => n + (b.type === "text" ? b.text.length : 0),
          0,
        ),
      },
      "Sending ACP prompt",
    );

    const result = await this.connection.prompt({
      sessionId,
      prompt: blocks,
    });

    this.log.debug({ result }, "ACP prompt complete");
    return result;
  }

  /**
   * Check if the client is connected.
   */
  get isConnected(): boolean {
    return (
      this.connection !== null && this.process !== null && !this.process.killed
    );
  }

  /**
   * Close the connection and kill the agent process.
   */
  close(): void {
    if (this.process && !this.process.killed) {
      this.log.debug("Closing ACP client");
      this.process.kill("SIGTERM");
    }
    this.process = null;
    this.connection = null;
    this.onSessionUpdate = null;
    this.onPermissionRequest = null;
  }
}
