import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SIDE_COMMAND = "yep:side-v1";
export const SIDE_PREFIX = "__YEP_PI_SIDE_V1__:";
const BOUNDARY =
  "You are in an independent read-only side conversation. Inherited history is reference material, not an active task. Only new messages after this boundary are instructions. Do not continue the main task or interact with its agents, processes, configuration, or external services. Only read, grep, find and ls are available here. If changes are needed, explain them for the user to bring back to the main task.";

async function loadInstalledSdk() {
  let root = dirname(await realpath(process.argv[1]));
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      );
      if (pkg.name === "@earendil-works/pi-coding-agent") {
        const entry = pkg.exports?.["."]?.import ?? pkg.main;
        if (typeof entry === "string")
          return import(pathToFileURL(resolve(root, entry)).href);
      }
    } catch {
      /* Walk only the CLI installation, never project modules. */
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  throw new Error(
    "Installed Pi SDK could not be loaded for side conversations.",
  );
}

/** Copy a stable branch; omit unfinished tool calls without editing the parent. */
export function snapshotMessages(messages) {
  const copy = structuredClone(messages);
  const resultIds = new Set(
    copy.filter((m) => m.role === "toolResult").map((m) => m.toolCallId),
  );
  const callIds = new Set(
    copy.flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? m.content
            .filter((c) => c.type === "toolCall" && resultIds.has(c.id))
            .map((c) => c.id)
        : [],
    ),
  );
  return copy.flatMap((message) => {
    if (message.role === "toolResult" && !callIds.has(message.toolCallId))
      return [];
    if (message.role === "assistant" && Array.isArray(message.content)) {
      message.content = message.content.filter(
        (part) => part.type !== "toolCall" || callIds.has(part.id),
      );
      if (!message.content.length) return [];
    }
    return [message];
  });
}

/** No global plugin install, parent messages, or custom TUI dependency. SDK loading is lazy. */
export function installPiSideConversations(pi, loadSdk = loadInstalledSdk) {
  const tokenKey = Symbol.for("yep.pi.side-token.v1");
  const token = process.env.YEP_PI_SIDE_TOKEN ?? globalThis[tokenKey];
  if (token) globalThis[tokenKey] = token;
  Reflect.deleteProperty(process.env, "YEP_PI_SIDE_TOKEN");
  if (!token || typeof pi.registerCommand !== "function") return;
  let child;
  let generation = 0;
  let pendingCreate;
  const emit = (ctx, id, event) => {
    ctx.ui.notify(`${SIDE_PREFIX}${JSON.stringify({ id, ...event })}`, "info");
  };
  const dispose = async () => {
    generation++;
    const previous = child;
    child = undefined;
    if (!previous) return;
    previous.unsubscribe?.();
    await previous.session.abort();
    previous.session.dispose();
  };

  pi.registerCommand(SIDE_COMMAND, {
    description: "Yep private side conversation protocol v1",
    handler: async (args, ctx) => {
      let command;
      try {
        command = JSON.parse(args);
      } catch {
        return;
      }
      if (
        !command ||
        command.token !== token ||
        typeof command.id !== "string" ||
        typeof command.requestId !== "string"
      )
        return;
      const reply = (data, error) =>
        emit(ctx, command.id, {
          type: "control",
          requestId: command.requestId,
          data,
          error,
        });
      try {
        if (command.action === "create") {
          if (child || pendingCreate)
            throw new Error("A side conversation is already open.");
          const epoch = ++generation;
          // Capture before the first await, while the parent may be streaming.
          const branch =
            command.context === "empty" ? [] : ctx.sessionManager.getBranch();
          let snapshotSize = 0;
          for (const entry of branch) {
            snapshotSize += JSON.stringify(entry).length;
            if (snapshotSize > 8_000_000)
              throw new Error(
                "Main branch is too large for a side snapshot. Start without main context.",
              );
          }
          const entries = structuredClone(branch);
          const leafId = ctx.sessionManager.getLeafId();
          const parentPrompt = ctx.getSystemPrompt();
          const model = ctx.model;
          const thinkingLevel = pi.getThinkingLevel();
          if (!model)
            throw new Error(
              "Select a model before starting a side conversation.",
            );
          pendingCreate = (async () => {
            const sdk = await loadSdk();
            for (const name of [
              "createAgentSession",
              "buildSessionContext",
              "createExtensionRuntime",
            ]) {
              if (typeof sdk[name] !== "function")
                throw new Error(
                  "Installed Pi does not support Yep side conversations.",
                );
            }
            const modelRuntime = await sdk.ModelRuntime.create({
              allowModelNetwork: false,
            });
            const provider = ctx.modelRegistry.getRegisteredProviderConfig(
              model.provider,
            );
            const native = ctx.modelRegistry.getRegisteredNativeProvider(
              model.provider,
            );
            if (native) modelRuntime.registerNativeProvider(native);
            else if (provider)
              modelRuntime.registerProvider(model.provider, provider);
            await modelRuntime.refresh({ allowNetwork: false });
            const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
            if (!auth.ok)
              throw new Error("The side model's credentials are unavailable.");
            if (auth.apiKey)
              await modelRuntime.setRuntimeApiKey(model.provider, auth.apiKey);
            const manager = sdk.SessionManager.inMemory(ctx.cwd);
            if (command.context !== "empty") {
              const messages = snapshotMessages(
                sdk.buildSessionContext(entries, leafId).messages,
              );
              if (JSON.stringify(messages).length > 8_000_000)
                throw new Error(
                  "Main context is too large for a side snapshot.",
                );
              for (const message of messages) manager.appendMessage(message);
            }
            manager.appendMessage({
              role: "user",
              content: [{ type: "text", text: BOUNDARY }],
              timestamp: Date.now(),
            });
            const empty = () => ({ diagnostics: [] });
            const resourceLoader = {
              getExtensions: () => ({
                extensions: [],
                errors: [],
                runtime: sdk.createExtensionRuntime(),
              }),
              getSkills: () => ({ ...empty(), skills: [] }),
              getPrompts: () => ({ ...empty(), prompts: [] }),
              getThemes: () => ({ ...empty(), themes: [] }),
              getAgentsFiles: () => ({ agentsFiles: [] }),
              getSystemPrompt: () => parentPrompt,
              getSystemPromptSource: () => undefined,
              getAppendSystemPrompt: () => [BOUNDARY],
              getAppendSystemPromptSources: () => [],
              extendResources() {},
              async reload() {},
            };
            const { session } = await sdk.createAgentSession({
              cwd: ctx.cwd,
              model,
              thinkingLevel,
              modelRuntime,
              sessionManager: manager,
              settingsManager: sdk.SettingsManager.inMemory({}),
              resourceLoader,
              tools: ["read", "grep", "find", "ls"],
              excludeTools: ["mcp__*"],
            });
            if (generation !== epoch) {
              session.dispose();
              throw new Error(
                "Parent session changed while creating the side conversation.",
              );
            }
            const current = {
              id: command.id,
              session,
              epoch,
              index: 0,
              busy: false,
              replyId: "",
            };
            child = current;
            current.unsubscribe = session.subscribe((event) => {
              if (
                child !== current ||
                current.epoch !== generation ||
                !current.busy
              )
                return;
              if (
                event.type === "message_start" &&
                event.message?.role === "assistant"
              )
                current.replyId = `side-${command.id}-${++current.index}`;
              if (
                event.type === "message_update" &&
                event.assistantMessageEvent?.type === "text_delta"
              )
                emit(ctx, current.id, {
                  type: "text",
                  id: current.id,
                  messageId: current.replyId,
                  text: event.assistantMessageEvent.delta,
                  append: true,
                });
              if (
                event.type === "message_end" &&
                event.message?.role === "assistant"
              ) {
                const text = event.message.content
                  .filter((p) => p.type === "text")
                  .map((p) => p.text)
                  .join("\n");
                emit(ctx, current.id, {
                  type: "text",
                  messageId: current.replyId,
                  text,
                });
              }
              if (event.type === "tool_execution_start")
                emit(ctx, current.id, {
                  type: "activity",
                  text: event.toolName,
                });
              if (event.type === "tool_execution_end")
                emit(ctx, current.id, { type: "activity" });
            });
            return { model: model.id, reasoningEffort: thinkingLevel };
          })();
          try {
            reply(await pendingCreate);
          } finally {
            pendingCreate = undefined;
          }
        } else if (command.action === "close") {
          await dispose();
          reply({});
        } else {
          const current = child;
          if (!current || current.id !== command.id)
            throw new Error("Side conversation has expired.");
          if (command.action === "interrupt") {
            await current.session.abort();
            reply({});
          } else if (command.action === "send") {
            if (current.busy) throw new Error("Side conversation is busy.");
            if (
              typeof command.text !== "string" ||
              !command.text.trim() ||
              command.text.length > 32_000
            )
              throw new Error("Invalid side question.");
            current.busy = true;
            reply({});
            // The command returns before the model runs; no parent agent_settled is expected.
            void current.session
              .prompt(command.text, {
                expandPromptTemplates: false,
                source: "extension",
              })
              .then(() => {
                if (child !== current) return;
                const last = current.session.messages
                  .filter((m) => m.role === "assistant")
                  .at(-1);
                emit(ctx, current.id, {
                  type: "done",
                  ...(last?.stopReason === "error"
                    ? { error: last.errorMessage || "Side model failed" }
                    : {}),
                  ...(last?.usage
                    ? {
                        usage: {
                          inputTokens:
                            (last.usage.input ?? 0) +
                            (last.usage.cacheRead ?? 0),
                          outputTokens: last.usage.output ?? 0,
                        },
                      }
                    : {}),
                });
              })
              .catch((error) => {
                if (child === current)
                  emit(ctx, current.id, {
                    type: "done",
                    error:
                      error instanceof Error
                        ? error.message
                        : "Side model failed",
                  });
              })
              .finally(() => {
                current.busy = false;
              });
          } else throw new Error("Unknown side action.");
        }
      } catch (error) {
        reply(
          undefined,
          error instanceof Error ? error.message : "Side operation failed",
        );
      }
    },
  });
  for (const event of ["session_shutdown", "session_switch", "session_tree"])
    pi.on(event, async (_event, ctx) => {
      const id = child?.id;
      try {
        await dispose();
      } finally {
        if (id) emit(ctx, id, { type: "closed" });
      }
    });
}
