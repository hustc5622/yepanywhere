# Agent Client Protocol (ACP) Integration

> Historical plan: OpenCode integration was retired from Yep Anywhere on 2026-08-18. Any OpenCode ACP/provider steps below are obsolete.

## Executive Summary

Replace our custom provider implementations (Codex, CodexOSS, Gemini, OpenCode) with a standardized ACP client. This separates concerns cleanly:

- **Agent (Brain)**: Reasoning, planning, tool selection, session persistence, conversation history
- **Yepanywhere (Body)**: Execute filesystem operations, run terminals, show UI, handle approvals

The agent controls its own loop and uses us for dumb I/O operations. We never store sessions - the agent handles persistence.

## Why We're Doing This

### Current Provider Problems

| Provider | Issues |
|----------|--------|
| **Codex** | Black-box file edits - SDK doesn't expose diffs, so we can't show users what changed |
| **CodexOSS** | Context truncation, janky CLI resume, text deduplication hacks |
| **Gemini** | Read-only - no write capability at all |
| **OpenCode** | Custom HTTP/SSE protocol - works but is non-standard |

All four require different integration code, different session readers, different quirks. It's 4x the maintenance burden.

### What ACP Solves

ACP (Agent Client Protocol) is a JSON-RPC standard created by Zed and adopted by JetBrains, Neovim, and others. It's the "LSP for AI agents."

Key insight: **The client executes tools, not the agent.**

| Operation | Protocol Method | Who Executes |
|-----------|-----------------|--------------|
| Read file | `fs/read_text_file` | Client (us) |
| Write file | `fs/write_text_file` | Client (us) |
| Run command | `terminal/create` | Client (us) |
| Store session | Internal to agent | Agent |

This means:
1. **Full visibility** - We see every file operation because we execute them
2. **No session persistence** - Agent handles its own JSONL files
3. **One integration** - Single ACP client works with all ACP-compatible agents
4. **Write capability everywhere** - Even Gemini can write files now

## Protocol Overview

### Transport

- Local agents: JSON-RPC over stdio (spawn subprocess, talk via stdin/stdout)
- Remote agents: JSON-RPC over HTTP/WebSocket (future)

### Core Flow

```
1. Client spawns agent:     spawn('gemini', ['--experimental-acp'])
2. Client sends:            initialize { clientCapabilities: {...} }
3. Agent responds:          { protocolVersion: 1, agentCapabilities: {...} }
4. Client sends:            session/new { cwd: "/path/to/project" }
5. Agent responds:          { sessionId: "sess_abc123" }
6. Client sends:            session/prompt { sessionId, messages: [...] }
7. Agent streams:           session/update notifications (thinking, tool calls, text)
8. Agent requests:          fs/read_text_file { path: "/src/foo.ts" }
9. Client responds:         { content: "file contents..." }
10. Agent requests:         fs/write_text_file { path: "/src/foo.ts", content: "..." }
11. Client executes write, responds: null (success)
12. Agent continues...
```

### Session Updates

Agent sends `session/update` notifications with different update types:

```json
{ "sessionUpdate": "agent_message_chunk", "content": [...] }
{ "sessionUpdate": "tool_call", "toolCallId": "...", "title": "Read file", "status": "pending" }
{ "sessionUpdate": "tool_call_update", "toolCallId": "...", "status": "completed" }
```

## Implementation Plan

### Phase 0: Proof of Concept (Brain Only)

**Goal**: Validate ACP protocol works with Gemini CLI. No tools - just chat.

**Files to create**:
- `packages/server/src/sdk/providers/acp/poc.ts` - Standalone test script

**Steps**:
1. Install SDK: `pnpm add @agentclientprotocol/sdk`
2. Spawn `gemini --experimental-acp`
3. Send `initialize` with empty `clientCapabilities`
4. Send `session/new`
5. Send `session/prompt` with a simple question
6. Log all `session/update` notifications
7. Verify we get a response

**Test command**:
```bash
npx tsx packages/server/src/sdk/providers/acp/poc.ts
```

**Expected output**:
```
[init] { protocolVersion: 1, agentCapabilities: {...} }
[session] sess_abc123
[session/update] { sessionUpdate: "agent_message_chunk", content: [...] }
...
```

If Gemini tries to read files, it will fail - that's fine. We're just validating the protocol works.

**Code sketch**:
```typescript
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

async function main() {
  const proc = spawn('gemini', ['--experimental-acp'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stderr?.on('data', (d) => console.error('[stderr]', d.toString()));

  const stream = ndJsonStream(
    Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>,
  );

  const connection = new ClientSideConnection(
    (agent) => ({}), // Empty client - no tool handlers
    stream,
  );

  const initResult = await connection.initialize({ clientCapabilities: {} });
  console.log('[init]', initResult);

  const { sessionId } = await connection.newSession({ cwd: process.cwd() });
  console.log('[session]', sessionId);

  const result = await connection.prompt({
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 2 + 2?' }] }],
  });
  console.log('[response]', JSON.stringify(result, null, 2));

  proc.kill();
}

main().catch(console.error);
```

---

### Phase 1: Gemini ACP Provider (Brain Only)

**Goal**: Add `gemini-acp` as a new provider alongside existing `gemini`. No tools yet.

**Files to create**:
- `packages/server/src/sdk/providers/acp/client.ts` - Reusable ACP client wrapper
- `packages/server/src/sdk/providers/gemini-acp.ts` - Provider implementation

**Files to modify**:
- `packages/server/src/sdk/providers/types.ts` - Add `"gemini-acp"` to `ProviderName`
- `packages/server/src/sdk/providers/index.ts` - Export new provider
- `packages/shared/src/types.ts` - Add provider to shared types if needed
- `packages/client/src/providers/registry.ts` - Register client-side provider

#### 1.1 ACP Client Wrapper

**File**: `packages/server/src/sdk/providers/acp/client.ts`

Wraps `@agentclientprotocol/sdk` with our conventions:

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type Agent,
} from '@agentclientprotocol/sdk';
import { getLogger } from '../../../logging/logger.js';

export interface ACPClientConfig {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface ACPToolHandlers {
  readTextFile?: (path: string, line?: number, limit?: number) => Promise<string>;
  writeTextFile?: (path: string, content: string) => Promise<void>;
  createTerminal?: (command: string, args: string[], cwd: string) => Promise<string>;
  // ... other tool handlers
}

export class ACPClient {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private log = getLogger();

  async connect(config: ACPClientConfig, tools: ACPToolHandlers = {}): Promise<void> {
    this.process = spawn(config.command, config.args ?? [], {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });

    this.process.stderr?.on('data', (data) => {
      this.log.debug({ stderr: data.toString() }, 'ACP agent stderr');
    });

    const stream = ndJsonStream(
      Writable.toWeb(this.process.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(this.process.stdout!) as ReadableStream<Uint8Array>,
    );

    this.connection = new ClientSideConnection(
      (agent: Agent): Client => this.createClientHandlers(tools),
      stream,
    );
  }

  private createClientHandlers(tools: ACPToolHandlers): Client {
    return {
      // Wire up tool handlers based on what's provided
      // For Phase 1, this is empty
    };
  }

  async initialize(capabilities: Record<string, boolean> = {}): Promise<unknown> {
    return this.connection!.initialize({ clientCapabilities: capabilities });
  }

  async newSession(cwd: string): Promise<string> {
    const result = await this.connection!.newSession({ cwd });
    return result.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.connection!.loadSession({ sessionId, cwd });
  }

  async prompt(sessionId: string, text: string): Promise<unknown> {
    return this.connection!.prompt({
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    });
  }

  close(): void {
    this.process?.kill();
    this.process = null;
    this.connection = null;
  }
}
```

#### 1.2 Gemini ACP Provider

**File**: `packages/server/src/sdk/providers/gemini-acp.ts`

```typescript
import type { ModelInfo } from '@yep-anywhere/shared';
import { getLogger } from '../../logging/logger.js';
import { MessageQueue } from '../messageQueue.js';
import type { SDKMessage } from '../types.js';
import { ACPClient } from './acp/client.js';
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from './types.js';

export class GeminiACPProvider implements AgentProvider {
  readonly name = 'gemini-acp' as const;
  readonly displayName = 'Gemini (ACP)';
  readonly supportsPermissionMode = true; // We handle permissions now!
  readonly supportsThinkingToggle = false;
  readonly supportsSlashCommands = false;

  private log = getLogger();

  async isInstalled(): Promise<boolean> {
    // Check if gemini CLI exists and supports --experimental-acp
    try {
      const { execSync } = await import('node:child_process');
      execSync('which gemini', { encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    // Check for OAuth creds
    const { existsSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    return existsSync(join(homedir(), '.gemini', 'oauth_creds.json'));
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const installed = await this.isInstalled();
    const authenticated = await this.isAuthenticated();
    return {
      installed,
      authenticated,
      enabled: installed && authenticated,
    };
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ];
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    const queue = new MessageQueue();
    const abortController = new AbortController();

    if (options.initialMessage) {
      queue.push(options.initialMessage);
    }

    const client = new ACPClient();
    const iterator = this.runSession(client, options, queue, abortController.signal);

    return {
      iterator,
      queue,
      abort: () => {
        abortController.abort();
        client.close();
      },
    };
  }

  private async *runSession(
    client: ACPClient,
    options: StartSessionOptions,
    queue: MessageQueue,
    signal: AbortSignal,
  ): AsyncIterableIterator<SDKMessage> {
    const args = ['--experimental-acp'];
    if (options.model) {
      args.push('--model', options.model);
    }

    await client.connect({
      command: 'gemini',
      args,
      cwd: options.cwd,
    });

    // Initialize with NO tool capabilities for Phase 1
    await client.initialize({});

    // Create or load session
    const sessionId = options.resumeSessionId
      ? (await client.loadSession(options.resumeSessionId, options.cwd), options.resumeSessionId)
      : await client.newSession(options.cwd);

    // Emit init message
    yield {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      cwd: options.cwd,
    } as SDKMessage;

    // Process messages from queue
    for await (const message of queue.generator()) {
      if (signal.aborted) break;

      // Emit user message
      yield {
        type: 'user',
        uuid: message.uuid,
        session_id: sessionId,
        message: { role: 'user', content: message.text },
      } as SDKMessage;

      // Send to agent and get response
      // TODO: Handle streaming updates properly
      const result = await client.prompt(sessionId, message.text);

      // Convert result to SDKMessage
      // TODO: Proper conversion based on ACP response format
      yield {
        type: 'assistant',
        session_id: sessionId,
        message: { role: 'assistant', content: JSON.stringify(result) },
      } as SDKMessage;
    }
  }
}

export const geminiACPProvider = new GeminiACPProvider();
```

#### 1.3 Register Provider

**File**: `packages/server/src/sdk/providers/types.ts`

```typescript
export type ProviderName =
  | "claude"
  | "codex"
  | "codex-oss"
  | "gemini"
  | "gemini-acp"  // Add this
  | "opencode";
```

**File**: `packages/server/src/sdk/providers/index.ts`

```typescript
import { geminiACPProvider } from './gemini-acp.js';

// Add to provider list
export const allProviders = [
  claudeProvider,
  codexProvider,
  codexOSSProvider,
  geminiProvider,
  geminiACPProvider,  // Add this
  opencodeProvider,
];
```

---

### Phase 2: Tool Execution

**Goal**: Implement filesystem and terminal tool handlers.

**Files to modify**:
- `packages/server/src/sdk/providers/acp/client.ts` - Add tool handler wiring
- `packages/server/src/sdk/providers/gemini-acp.ts` - Pass tool handlers

#### 2.1 Filesystem Tools

```typescript
// In ACPClient.createClientHandlers()
return {
  fs: {
    readTextFile: async (params) => {
      const content = await fs.readFile(params.path, 'utf-8');
      // Handle line/limit params if provided
      return { content };
    },
    writeTextFile: async (params) => {
      // Check approval if onToolApproval is set
      if (this.onToolApproval) {
        const result = await this.onToolApproval('Write', {
          path: params.path,
          content: params.content,
        }, { signal: this.signal });
        if (result.behavior === 'deny') {
          throw new Error('User denied write operation');
        }
      }
      await fs.writeFile(params.path, params.content, 'utf-8');
      return null;
    },
  },
};
```

#### 2.2 Terminal Tools

```typescript
terminal: {
  create: async (params) => {
    // Check approval
    if (this.onToolApproval) {
      const result = await this.onToolApproval('Bash', {
        command: params.command,
        args: params.args,
      }, { signal: this.signal });
      if (result.behavior === 'deny') {
        throw new Error('User denied command');
      }
    }

    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd,
      shell: true,
    });

    const terminalId = generateTerminalId();
    this.terminals.set(terminalId, proc);
    return { terminalId };
  },

  output: async (params) => {
    const proc = this.terminals.get(params.terminalId);
    // Return buffered output
  },

  waitForExit: async (params) => {
    const proc = this.terminals.get(params.terminalId);
    // Wait for process to exit, return code
  },

  kill: async (params) => {
    const proc = this.terminals.get(params.terminalId);
    proc?.kill();
  },

  release: async (params) => {
    this.terminals.delete(params.terminalId);
  },
},
```

#### 2.3 Permission Modes

Map our permission modes to tool approval behavior:

```typescript
private shouldAutoApprove(toolName: string, mode: PermissionMode): boolean {
  switch (mode) {
    case 'bypassPermissions': // yolo
      return true;
    case 'acceptEdits': // auto-edit
      return ['fs/read_text_file', 'fs/write_text_file'].includes(toolName);
    case 'plan':
      return toolName === 'fs/read_text_file';
    case 'default':
    default:
      return toolName === 'fs/read_text_file';
  }
}
```

---

### Phase 3: SDKMessage Conversion

**Goal**: Properly convert ACP `session/update` notifications to our `SDKMessage` format.

The SDK's `prompt()` method handles streaming internally. We need to hook into the update stream and convert each update to an SDKMessage that our existing UI understands.

#### 3.1 Update Type Mapping

| ACP Update | SDKMessage Type | Notes |
|------------|-----------------|-------|
| `agent_message_chunk` | `assistant` | Streaming text content |
| `plan` | `assistant` (thinking?) | Agent's plan/reasoning |
| `tool_call` (pending) | `assistant` with `tool_use` | Tool invocation started |
| `tool_call_update` (completed) | `user` with `tool_result` | Tool finished |

#### 3.2 Streaming Handler

```typescript
// Instead of awaiting prompt(), stream updates
for await (const update of connection.promptStream(params)) {
  yield convertACPUpdateToSDKMessage(update, sessionId);
}
```

---

### Phase 4: Additional Providers

**Goal**: Add ACP support for Codex and OpenCode.

#### 4.1 Codex ACP

Uses Zed's `codex-acp` adapter (Rust binary).

**Installation**: Download from https://github.com/zed-industries/codex-acp/releases or build from source.

```typescript
export class CodexACPProvider implements AgentProvider {
  readonly name = 'codex-acp' as const;
  readonly displayName = 'Codex (ACP)';

  // Same pattern as GeminiACPProvider, but:
  // - command: 'codex-acp'
  // - Check ~/.codex/auth.json for auth
}
```

#### 4.2 OpenCode ACP

OpenCode has native ACP support via `opencode acp` command.

```typescript
export class OpenCodeACPProvider implements AgentProvider {
  readonly name = 'opencode-acp' as const;
  readonly displayName = 'OpenCode (ACP)';

  // Same pattern, but:
  // - command: 'opencode'
  // - args: ['acp']
}
```

---

### Phase 5: Cleanup

**Goal**: Remove old provider implementations once ACP versions are stable.

**Files to delete**:
- `packages/server/src/sdk/providers/codex.ts`
- `packages/server/src/sdk/providers/codex-oss.ts`
- `packages/server/src/sdk/providers/gemini.ts`
- `packages/server/src/sdk/providers/opencode.ts`
- `packages/server/src/sessions/codex-reader.ts`
- `packages/server/src/sessions/gemini-reader.ts`
- `packages/server/src/sessions/opencode-reader.ts`
- `packages/shared/src/codex-schema/` (if exists)
- `packages/shared/src/gemini-schema/` (if exists)
- `packages/shared/src/opencode-schema/`

**Files to simplify**:
- `packages/server/src/sdk/providers/types.ts` - Remove old provider names
- `packages/server/src/sdk/providers/index.ts` - Remove old exports

---

## Testing Strategy

### Phase 0 Testing

Manual testing with the PoC script:
```bash
npx tsx packages/server/src/sdk/providers/acp/poc.ts
```

Expected: See `[init]`, `[session]`, and `[response]` logs with actual content from Gemini.

### Phase 1 Testing

1. Start yepanywhere: `pnpm dev`
2. Create new session with "Gemini (ACP)" provider
3. Send a simple message like "Hello, what's your name?"
4. Verify response appears in UI

### Phase 2 Testing

1. Ask Gemini to read a file: "What's in package.json?"
2. Verify file content is returned (we execute the read)
3. Ask Gemini to write a file: "Create a file called test.txt with 'hello'"
4. Verify approval dialog appears
5. Approve and verify file is created

### E2E Tests

Add to `packages/server/test/e2e/`:
- `gemini-acp.e2e.test.ts` - Basic session lifecycle
- `gemini-acp-tools.e2e.test.ts` - Tool execution flow

---

## Dependencies

### NPM Packages

```bash
pnpm add @agentclientprotocol/sdk
```

### External Binaries

| Provider | Binary | How to Get |
|----------|--------|------------|
| Gemini | `gemini` | `npm install -g @anthropic-ai/gemini-cli` or similar |
| Codex | `codex-acp` | Download from GitHub releases or build from source |
| OpenCode | `opencode` | Already supported |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Yepanywhere Server                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                      Provider Layer                          ││
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       ││
│  │  │ ClaudeProvider│  │GeminiACPProv │  │CodexACPProv  │       ││
│  │  │  (SDK-native) │  │  (ACP)       │  │  (ACP)       │       ││
│  │  └──────────────┘  └──────┬───────┘  └──────┬───────┘       ││
│  │                           │                  │                ││
│  │                    ┌──────┴──────────────────┴──────┐        ││
│  │                    │         ACPClient              │        ││
│  │                    │  - JSON-RPC over stdio         │        ││
│  │                    │  - Tool execution              │        ││
│  │                    │  - Permission checking         │        ││
│  │                    └──────────────┬─────────────────┘        ││
│  └───────────────────────────────────┼──────────────────────────┘│
│                                      │                           │
│  ┌───────────────────────────────────┼──────────────────────────┐│
│  │              Tool Handlers        │                          ││
│  │  ┌────────────┐  ┌────────────┐  │  ┌────────────┐          ││
│  │  │fs/read_text│  │fs/write_txt│  │  │terminal/*  │          ││
│  │  │   file     │  │   file     │  │  │            │          ││
│  │  └────────────┘  └────────────┘  │  └────────────┘          ││
│  └───────────────────────────────────┼──────────────────────────┘│
└──────────────────────────────────────┼───────────────────────────┘
                                       │
                              spawn + stdio
                                       │
                    ┌──────────────────┴──────────────────┐
                    │           Agent Process             │
                    │  (gemini --experimental-acp)        │
                    │                                     │
                    │  - LLM inference                    │
                    │  - Reasoning & planning             │
                    │  - Session persistence              │
                    │  - Conversation history             │
                    └─────────────────────────────────────┘
```

---

## Success Criteria

### Phase 0
- [ ] PoC script runs without errors
- [ ] Gemini responds to simple prompts
- [ ] We can see session/update notifications

### Phase 1
- [ ] `gemini-acp` appears in provider list
- [ ] Can create sessions with Gemini ACP
- [ ] Basic chat works (brain only)
- [ ] No regressions in existing providers

### Phase 2
- [ ] File reads work (fs/read_text_file)
- [ ] File writes work with approval (fs/write_text_file)
- [ ] Terminal commands work with approval (terminal/*)
- [ ] Permission modes respected

### Phase 3
- [ ] Streaming updates appear in UI correctly
- [ ] Tool calls show in UI with status
- [ ] Text content streams smoothly

### Phase 4
- [ ] Codex ACP provider works
- [ ] OpenCode ACP provider works

### Phase 5
- [ ] Old providers removed
- [ ] Codebase is simpler
- [ ] All tests pass

---

## References

- [Agent Client Protocol Docs](https://agentclientprotocol.com)
- [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [SDK API Reference](https://agentclientprotocol.github.io/typescript-sdk)
- [Zed ACP Blog Post](https://zed.dev/blog/bring-your-own-agent-to-zed)
- [Codex ACP Adapter](https://github.com/zed-industries/codex-acp)
- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli)

---

## Notes

- Claude remains first-class with native SDK integration - no ACP for Claude unless they add support and it's proven equivalent
- Session persistence is intentionally NOT our responsibility - agents handle their own state
- Permission modes map to tool approval behavior, not agent-side rules
- Future: Could add more ACP agents as they become available (Goose, Augment, etc.)
