import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension, {
  redirectedLogPaths,
} from "../../resources/pi-yep-extension.mjs";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
const roots: string[] = [];
const cleanups: Array<() => void> = [];
const prefix = "__YEP_PI_TOOL_PARTIAL__:";

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "yep-log-tail-"));
  roots.push(root);
  const handlers = new Map<string, Handler>();
  const notify = vi.fn();
  const ctx = { cwd: root, ui: { notify } };
  extension({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    registerProvider: vi.fn(),
  });
  const emit = (name: string, event: Record<string, unknown> = {}) =>
    handlers.get(name)?.(event, ctx);
  cleanups.push(() => {
    emit("session_shutdown");
  });
  return {
    root,
    notify,
    emit,
    frames: () =>
      notify.mock.calls.map(([message]) =>
        JSON.parse(String(message).slice(prefix.length)),
      ),
    start: (command: string, id = "test") =>
      emit("tool_execution_start", {
        toolName: "bash",
        toolCallId: id,
        args: { command },
      }),
  };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Pi redirected log detection", () => {
  it("recognizes the screenshot command without interpreting its PATH assignment", () => {
    expect(
      redirectedLogPaths(
        'cd /work/project; git status --short | wc -l; time (PATH="$PWD/.venv/bin:$PATH" scripts/test.sh full --junitxml=/tmp/full.xml > /tmp/full_now.log 2>&1); tail -3 /tmp/full_now.log',
        "/work",
      ),
    ).toEqual(["/tmp/full_now.log"]);
  });
  it.each([
    ["pytest > tests.log 2>&1", ["/work/tests.log"]],
    [
      'cd "project dir" && pytest >> "tests out.log"',
      ["/work/project dir/tests out.log"],
    ],
    ["pytest 2> errors.log > out.log", ["/work/errors.log", "/work/out.log"]],
    ["pytest &> /tmp/all.log", ["/tmp/all.log"]],
    ["echo 'pytest > /tmp/not-a-log'", []],
    ["echo ok # > /tmp/not-a-log", []],
    ["pytest > /dev/null 2>&1", []],
    ["pytest > $LOG", []],
    ['pytest > "$LOG"', []],
    ["pytest > $(choose_path)", []],
    ["cat << EOF\npytest > /tmp/not-a-log\nEOF", []],
    ["cd $PROJECT; pytest > relative.log", []],
    ["cd -; pytest > relative.log", []],
    [String.raw`pytest > "foo\q.log"`, [String.raw`/work/foo\q.log`]],
    ["(cd /other; pytest > relative.log)", []],
  ])("parses %s conservatively", (command, expected) => {
    expect(redirectedLogPaths(command, "/work")).toEqual(expected);
  });
});

describe("Pi log file following", () => {
  it("follows a real redirected command before completion, then stops", async () => {
    const h = await harness();
    const path = join(h.root, "tests.log");
    await h.start(
      'printf "first test passed\\n" > tests.log; sleep 1; printf "second test passed\\n" >> tests.log',
    );
    const child = promisify(execFile)(
      "/bin/sh",
      [
        "-c",
        'printf "first test passed\\n" > tests.log; sleep 1; printf "second test passed\\n" >> tests.log',
      ],
      { cwd: h.root },
    );
    await vi.waitFor(
      () => expect(h.frames().at(-1)?.text).toContain("first test passed"),
      { timeout: 2500 },
    );
    expect(h.frames().at(-1)).toMatchObject({
      source: "log",
      toolCallId: "test",
    });
    expect(h.frames().at(-1)?.text).toContain(path);
    await child;
    await vi.waitFor(
      () => expect(h.frames().at(-1)?.text).toContain("second test passed"),
      { timeout: 2500 },
    );
    await h.emit("tool_execution_end", { toolCallId: "test" });
    const count = h.notify.mock.calls.length;
    await appendFile(path, "after completion\n");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(h.notify).toHaveBeenCalledTimes(count);
  });

  it("ignores stale logs, follows truncation and rotation, and clears removed files", async () => {
    const h = await harness();
    const path = join(h.root, "tests.log");
    await writeFile(path, "stale output\n");
    await h.start("pytest > tests.log");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(h.notify).not.toHaveBeenCalled();
    await writeFile(path, "new output\n");
    await vi.waitFor(
      () => expect(h.frames().at(-1)?.text).toContain("new output"),
      { timeout: 2000 },
    );
    await writeFile(path, "ok\n");
    await vi.waitFor(
      () => expect(h.frames().at(-1)?.text).toBe(`--- ${path} ---\nok`),
      { timeout: 2000 },
    );
    await rm(path);
    await writeFile(path, "rotated\n");
    await vi.waitFor(
      () => expect(h.frames().at(-1)?.text).toContain("rotated"),
      { timeout: 2000 },
    );
    await rm(path);
    await vi.waitFor(() => expect(h.frames().at(-1)?.text).toBe(""), {
      timeout: 2000,
    });
  });

  it("bounds large tails and cleans up on agent end", async () => {
    const h = await harness();
    const path = join(h.root, "tests.log");
    await h.start("pytest > tests.log");
    await writeFile(path, `${"x".repeat(100_000)}\nlast test\n`);
    await vi.waitFor(
      () => expect(h.frames().at(-1)?.text).toContain("last test"),
      { timeout: 2000 },
    );
    expect(h.frames().at(-1)?.text.length).toBeLessThanOrEqual(8000);
    await h.emit("agent_end");
    const count = h.notify.mock.calls.length;
    await writeFile(path, "should not arrive");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(h.notify).toHaveBeenCalledTimes(count);
  });

  it("does not block on a FIFO and still reads a second ordinary log", async () => {
    const h = await harness();
    await promisify(execFile)("mkfifo", [join(h.root, "pipe")]);
    await h.start("pytest > pipe 2> errors.log");
    await writeFile(join(h.root, "errors.log"), "failure details\n");
    await vi.waitFor(
      () => expect(h.frames().at(-1)?.text).toContain("failure details"),
      { timeout: 2000 },
    );
  });
});
