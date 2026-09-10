import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * Yep's temporary, process-local Pi integration.
 *
 * Loaded explicitly with `pi --extension`; it neither installs files under
 * ~/.pi nor mutates the user's models.json. The server supplies a generated
 * provider catalog through YEP_PI_PROVIDER_CONFIG for this child only, and the
 * per-provider gateway credentials through YEP_PI_LLM_API_KEYS.
 */

const APPROVAL_TITLE_PREFIX = "__YEP_PI_TOOL_APPROVAL__:";
const MAX_APPROVAL_PAYLOAD_CHARS = 200_000;
const PROVIDER_STATE_KEY = Symbol.for("yep.pi.provider-config.v1");

// Relay bounded previews through the extension UI channel. Native RPC progress
// is also consumed by the provider; file tails are read here on the tool host.
const PARTIAL_OUTPUT_PREFIX = "__YEP_PI_TOOL_PARTIAL__:";
const MAX_PARTIAL_OUTPUT_CHARS = 8_000;
// The bash tool already throttles its own updates to 100ms; this is a second
// gate so a chattier tool cannot flood the RPC stdout stream.
const PARTIAL_OUTPUT_THROTTLE_MS = 200;
const MAX_TRACKED_TOOL_CALLS = 32;

function parseProviderConfig() {
  const retained = globalThis[PROVIDER_STATE_KEY];
  if (retained && Array.isArray(retained.providers)) return retained;

  const raw = process.env.YEP_PI_PROVIDER_CONFIG;
  // One key per generated provider: Yep can register several gateways, and
  // each gateway has its own credential. The legacy single-key variable is
  // still honoured as a fallback for a provider with no entry in the map.
  const rawKeys = process.env.YEP_PI_LLM_API_KEYS;
  const fallbackApiKey = process.env.YEP_PI_LLM_API_KEY;

  // Pi's bash tool inherits process.env. Remove server-owned configuration as
  // soon as the extension has captured it so tool subprocesses cannot read it.
  Reflect.deleteProperty(process.env, "YEP_PI_PROVIDER_CONFIG");
  Reflect.deleteProperty(process.env, "YEP_PI_LLM_API_KEYS");
  Reflect.deleteProperty(process.env, "YEP_PI_LLM_API_KEY");

  let apiKeys = {};
  if (rawKeys) {
    try {
      const parsedKeys = JSON.parse(rawKeys);
      if (parsedKeys && typeof parsedKeys === "object") apiKeys = parsedKeys;
    } catch {
      // Fall through with no map; providers without a key are dropped below.
    }
  }

  if (!raw || (!fallbackApiKey && Object.keys(apiKeys).length === 0)) {
    const empty = { providers: [] };
    globalThis[PROVIDER_STATE_KEY] = empty;
    return empty;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.providers)) {
      const empty = { providers: [] };
      globalThis[PROVIDER_STATE_KEY] = empty;
      return empty;
    }
    const providers = parsed.providers
      .filter(
        (provider) =>
          provider &&
          typeof provider.id === "string" &&
          provider.id.length > 0 &&
          provider.config &&
          typeof provider.config === "object",
      )
      .map((provider) => {
        const apiKey =
          typeof apiKeys[provider.id] === "string" && apiKeys[provider.id]
            ? apiKeys[provider.id]
            : fallbackApiKey;
        return apiKey
          ? { id: provider.id, config: { ...provider.config, apiKey } }
          : null;
      })
      // Fail closed: a provider with no credential would surface as a model
      // that always errors at request time.
      .filter((provider) => provider !== null);
    // Pi recreates its AgentSession and reloads extensions after a native
    // fork/resume. Retain the captured config in this child process so the
    // generated provider is registered again without putting the gateway key
    // back into process.env (which the bash tool inherits).
    const config = {
      providers,
      ...(typeof parsed.globalInstructions === "string" &&
      parsed.globalInstructions.trim()
        ? { globalInstructions: parsed.globalInstructions.trim() }
        : {}),
    };
    globalThis[PROVIDER_STATE_KEY] = config;
    return config;
  } catch {
    const empty = { providers: [] };
    globalThis[PROVIDER_STATE_KEY] = empty;
    return empty;
  }
}

function partialResultText(partialResult) {
  if (typeof partialResult === "string") return partialResult;
  if (!partialResult || typeof partialResult !== "object") return "";
  const content = partialResult.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

// A deliberately conservative shell lexer: never evaluate command text. Quoted
// operators are words; dynamic paths, substitutions and heredocs are skipped.
export function redirectedLogPaths(command, cwd) {
  if (
    typeof command !== "string" ||
    command.length > 100_000 ||
    /`|\$\(|<<|\\\n/.test(command)
  )
    return [];
  const tokens = [];
  let word = "";
  let quote = "";
  let dynamic = false;
  let started = false;
  const flush = () => {
    if (started) tokens.push({ word, dynamic });
    word = "";
    dynamic = false;
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\" && quote !== "'") {
      if (i + 1 >= command.length) return [];
      // Inside double quotes Bash only unescapes $, `, ", \ and newline.
      // Other backslashes remain part of the literal filename.
      if (
        quote === '"' &&
        !["$", "`", '"', "\\", "\n"].includes(command[i + 1])
      )
        word += "\\";
      word += command[++i];
      started = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      else {
        word += c;
        if (quote === '"' && c === "$") dynamic = true;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i++;
      tokens.push({ op: ";" });
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      if (c === "\n") tokens.push({ op: ";" });
      continue;
    }
    if ("><;&|()".includes(c)) {
      flush();
      const pair = c + (command[i + 1] ?? "");
      if ([">>", "&>", "&&", "||", ">&", "<(", ">("].includes(pair)) {
        tokens.push({ op: pair });
        i++;
      } else tokens.push({ op: c });
      continue;
    }
    started = true;
    word += c;
    if (/[\$~*?{}\[\]]/.test(c)) dynamic = true;
  }
  if (quote) return [];
  flush();
  // Resolve relative paths only with an unambiguous working directory. A
  // leading literal cd is common; later cd/subshells make relative paths unsafe.
  let base = cwd;
  let offset = 0;
  if (
    tokens[0]?.word === "cd" &&
    tokens[1]?.word &&
    !tokens[1].dynamic &&
    !tokens[1].word.startsWith("-") &&
    [";", "&&"].includes(tokens[2]?.op)
  ) {
    base = base ? resolve(base, tokens[1].word) : undefined;
    offset = 3;
  }
  if (
    tokens
      .slice(offset)
      .some((t) => t.word === "cd" || t.op === "(" || t.op === ")")
  )
    base = undefined;
  const paths = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (![">", ">>", "&>"].includes(tokens[i].op)) continue;
    const target = tokens[i + 1];
    if (!target.word || target.dynamic) continue;
    if (!isAbsolute(target.word) && !base) continue;
    const path = resolve(base ?? "/", target.word);
    if (/^\/(dev|proc|sys)(\/|$)/.test(path)) continue;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths.slice(0, 3);
}

function fileRevision(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

// O_NONBLOCK prevents a path replaced with a FIFO from hanging the agent.
async function readLogTail(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(info.size, 6_000));
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      Math.max(0, info.size - buffer.length),
    );
    const text = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .replace(/\r\n?/g, "\n");
    return {
      revision: fileRevision(info),
      text: text.replace(/\n$/, "").split("\n").slice(-10).join("\n"),
    };
  } finally {
    await handle.close();
  }
}

// Updates are snapshots, not deltas. Keep the latest tail even if its length
// stays equal or shrinks; final tool results still arrive through normal RPC.
function registerPartialOutputRelay(pi) {
  /** @type {Map<string, { timer: NodeJS.Timeout | undefined, pending: string | undefined, lastSentAt: number, lastSent: string }>} */
  const states = new Map();
  const followers = new Map();

  const send = (ctx, toolCallId, text) => {
    const state = states.get(toolCallId);
    if (state) {
      state.pending = undefined;
      state.lastSentAt = Date.now();
      state.lastSent = text;
    }
    try {
      ctx.ui.notify(
        `${PARTIAL_OUTPUT_PREFIX}${JSON.stringify({ toolCallId, text })}`,
      );
    } catch {
      // A notify failure must never break tool execution.
    }
  };

  const clear = (toolCallId) => {
    const state = states.get(toolCallId);
    if (state?.timer) clearTimeout(state.timer);
    states.delete(toolCallId);
    const follower = followers.get(toolCallId);
    if (follower) {
      follower.active = false;
      clearInterval(follower.timer);
    }
    followers.delete(toolCallId);
  };

  pi.on("tool_execution_start", async (event, ctx) => {
    clear(event.toolCallId);
    if (event.toolName !== "bash" || !event.toolCallId) return;
    const paths = redirectedLogPaths(event.args?.command, ctx.cwd);
    if (!paths.length) return;
    const follower = {
      active: true,
      busy: false,
      timer: undefined,
      lastSent: "",
    };
    followers.set(event.toolCallId, follower);
    while (followers.size > MAX_TRACKED_TOOL_CALLS)
      clear(followers.keys().next().value);
    const files = await Promise.all(
      paths.map(async (path) => {
        let baseline;
        try {
          baseline = fileRevision(await stat(path));
        } catch {
          /* not created yet */
        }
        return { path, baseline, text: "" };
      }),
    );
    if (!follower.active) return;
    const poll = async () => {
      if (!follower.active || follower.busy) return;
      follower.busy = true;
      try {
        for (const file of files) {
          try {
            const tail = await readLogTail(file.path);
            file.text =
              tail && tail.revision !== file.baseline ? tail.text : "";
          } catch {
            file.text = "";
          }
        }
        const text = files
          .filter((file) => file.text)
          .map((file) => `--- ${file.path} ---\n${file.text}`)
          .join("\n")
          .slice(-MAX_PARTIAL_OUTPUT_CHARS);
        if (follower.active && text !== follower.lastSent) {
          follower.lastSent = text;
          try {
            ctx.ui.notify(
              `${PARTIAL_OUTPUT_PREFIX}${JSON.stringify({ toolCallId: event.toolCallId, text, source: "log" })}`,
            );
          } catch {
            /* previews must not break execution */
          }
        }
      } finally {
        follower.busy = false;
      }
    };
    follower.timer = setInterval(() => {
      void poll();
    }, 500);
    follower.timer.unref?.();
  });

  pi.on("tool_execution_update", (event, ctx) => {
    const toolCallId = event.toolCallId;
    if (typeof toolCallId !== "string" || !toolCallId) return;
    const full = partialResultText(event.partialResult);
    if (!full) return;
    const text =
      full.length > MAX_PARTIAL_OUTPUT_CHARS
        ? full.slice(-MAX_PARTIAL_OUTPUT_CHARS)
        : full;

    let state = states.get(toolCallId);
    if (!state) {
      state = {
        timer: undefined,
        pending: undefined,
        lastSentAt: 0,
        lastSent: "",
      };
      states.set(toolCallId, state);
      // `tool_execution_end` normally removes the entry; evict the oldest ones
      // anyway so an aborted turn cannot retain snapshots for the lifetime of
      // the Pi process.
      while (states.size > MAX_TRACKED_TOOL_CALLS) {
        const oldest = states.keys().next();
        if (oldest.done) break;
        clear(oldest.value);
      }
    }
    if (text === state.lastSent) return;

    const wait = PARTIAL_OUTPUT_THROTTLE_MS - (Date.now() - state.lastSentAt);
    if (wait <= 0) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      send(ctx, toolCallId, text);
      return;
    }

    // Coalesce into a trailing emit so a burst of updates still ends on the
    // newest snapshot instead of a stale one.
    state.pending = text;
    state.timer ??= setTimeout(() => {
      const current = states.get(toolCallId);
      if (!current) return;
      current.timer = undefined;
      const pending = current.pending;
      if (pending === undefined) return;
      send(ctx, toolCallId, pending);
    }, wait);
    state.timer.unref?.();
  });

  pi.on("tool_execution_end", (event) => {
    clear(event.toolCallId);
  });
  const clearAll = () => {
    for (const id of new Set([...states.keys(), ...followers.keys()]))
      clear(id);
  };
  pi.on("agent_end", clearAll);
  pi.on("session_shutdown", clearAll);
  pi.on("session_switch", clearAll);
}

function serializeApproval(event) {
  let payload;
  try {
    payload = JSON.stringify({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input,
    });
  } catch {
    payload = JSON.stringify({
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: {},
    });
  }
  return payload.length <= MAX_APPROVAL_PAYLOAD_CHARS
    ? payload
    : JSON.stringify({
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: {},
        truncated: true,
      });
}

export default function yepPiExtension(pi) {
  const config = parseProviderConfig();
  for (const provider of config.providers) {
    pi.registerProvider(provider.id, provider.config);
  }

  if (config.globalInstructions) {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${config.globalInstructions}`,
    }));
  }

  registerPartialOutputRelay(pi);

  pi.on("tool_call", async (event, ctx) => {
    const approved = await ctx.ui.confirm(
      `${APPROVAL_TITLE_PREFIX}${event.toolName}`,
      serializeApproval(event),
    );
    if (!approved) {
      return {
        block: true,
        reason: "The tool call was denied by the user in Yep.",
      };
    }
    return undefined;
  });
}

export { APPROVAL_TITLE_PREFIX, PARTIAL_OUTPUT_PREFIX };
