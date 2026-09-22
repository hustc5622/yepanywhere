import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PI_FILE_OPERATION_PREFIX = "__YEP_PI_FILE_OPERATION__:";
const MAX_BYTES = 8 * 1024 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function boundedPreimage(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== info.size) return undefined;
    return buffer.subarray(0, length);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function persistArtifact(directory, record, ctx) {
  const text = JSON.stringify(record);
  const id = hash(text);
  const folder = join(directory, hash(record.sessionId));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  // Bound the pending delivery spool; successfully imported artifacts are removed by the server.
  const names = await readdir(folder);
  let pendingBytes = 0;
  for (const name of names) {
    try {
      pendingBytes += (await stat(join(folder, name))).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (
    names.length >= 128 ||
    pendingBytes + Buffer.byteLength(text) > 64 * 1024 * 1024
  ) {
    throw new Error("Pi file operation delivery spool limit exceeded");
  }
  const temporary = join(folder, `${id}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, join(folder, `${id}.json`));
  // The notification contains an opaque ID only. The persisted artifact carries the content.
  ctx.ui?.notify?.(`${PI_FILE_OPERATION_PREFIX}${id}`, "info");
}

/** Delegate to Pi's native tool definitions, capturing the actual operations they perform. */
export function registerPiFileOperationTools(pi, sdk, publish) {
  if (
    typeof sdk.createEditToolDefinition !== "function" ||
    typeof sdk.createWriteToolDefinition !== "function"
  )
    return false;
  for (const name of ["edit", "write"]) {
    const create =
      name === "edit"
        ? sdk.createEditToolDefinition
        : sdk.createWriteToolDefinition;
    const original = create(process.cwd());
    pi.registerTool({
      ...original,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        // Resolve the native assistant owning this call before I/O/approval continuations
        // can append another user turn. Never assign a completed write to the latest user.
        let owner;
        try {
          const branch = ctx.sessionManager.getBranch();
          const callIndex = branch.findLastIndex(
            (entry) =>
              entry.type === "message" &&
              entry.message?.role === "assistant" &&
              Array.isArray(entry.message.content) &&
              entry.message.content.some(
                (block) => block.type === "toolCall" && block.id === toolCallId,
              ),
          );
          const user =
            callIndex >= 0
              ? branch
                  .slice(0, callIndex + 1)
                  .findLast(
                    (entry) =>
                      entry.type === "message" &&
                      entry.message?.role === "user",
                  )
              : undefined;
          if (user?.id)
            owner = {
              sessionId: ctx.sessionManager.getSessionId(),
              turnId: user.id,
              workspace: ctx.cwd,
            };
        } catch {
          /* Missing identity degrades capture, not the native tool. */
        }
        let before;
        let after;
        let path;
        let written = false;
        let attempted = false;
        const operations = {
          access: (target) => access(target, constants.R_OK | constants.W_OK),
          mkdir: async (target) => {
            await mkdir(target, { recursive: true });
          },
          readFile: async (target) => {
            const bytes = await readFile(target);
            path = target;
            before = bytes.length <= MAX_BYTES ? bytes : undefined;
            return bytes;
          },
          writeFile: async (target, content) => {
            path = target;
            if (name === "write") before = await boundedPreimage(target);
            attempted = true;
            await writeFile(target, content, "utf8");
            written = true;
            const bytes = Buffer.from(content);
            after = bytes.length <= MAX_BYTES ? bytes : undefined;
          },
        };
        try {
          return await create(ctx.cwd, { operations }).execute(
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx,
          );
        } finally {
          if (attempted && path) {
            try {
              if (!owner) {
                ctx.ui?.notify?.(
                  `${PI_FILE_OPERATION_PREFIX}capture-failed`,
                  "warning",
                );
              } else
                await publish(
                  {
                    version: 1,
                    sessionId: owner.sessionId,
                    turnId: owner.turnId,
                    toolCallId,
                    toolName: name,
                    workspace: owner.workspace,
                    path,
                    timestamp: new Date().toISOString(),
                    written,
                    ...(before === null
                      ? { before: null }
                      : before
                        ? { before: before.toString("base64") }
                        : {}),
                    ...(after ? { after: after.toString("base64") } : {}),
                  },
                  ctx,
                );
            } catch {
              // Storage trouble must not replace a real tool result or make a completed write retry.
              ctx.ui?.notify?.(
                `${PI_FILE_OPERATION_PREFIX}capture-failed`,
                "warning",
              );
            }
          }
        }
      },
    });
  }
  return true;
}

export async function installPiFileOperationTools(pi, directory) {
  if (!directory || typeof pi.registerTool !== "function") return;
  let root = dirname(await realpath(process.argv[1]));
  let sdkPath;
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      );
      if (pkg.name === "@earendil-works/pi-coding-agent") {
        const entry = pkg.exports?.["."]?.import ?? pkg.main;
        if (typeof entry === "string") sdkPath = resolve(root, entry);
        break;
      }
    } catch {
      /* Only inspect the CLI installation's ancestors, never workspace files. */
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  if (!sdkPath) throw new Error("Cannot locate the installed Pi SDK");
  const sdk = await import(pathToFileURL(sdkPath).href);
  if (
    !registerPiFileOperationTools(pi, sdk, (record, ctx) =>
      persistArtifact(directory, record, ctx),
    )
  ) {
    throw new Error(
      "Installed Pi does not expose file tool operation adapters",
    );
  }
}
