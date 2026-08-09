import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type FeishuBindingsFile,
  FeishuBindingsFileSchema,
  type FeishuSessionBinding,
  FeishuSessionBindingSchema,
} from "@yep-anywhere/shared";
import { atomicWriteJson } from "../../utils/atomic-json-file.js";

export class FeishuBindingStore {
  readonly filePath: string;
  private state: FeishuBindingsFile = { version: 1, bindings: [] };
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string }) {
    this.filePath = join(
      options.dataDir,
      "channels",
      "feishu",
      "bindings.json",
    );
  }

  async initialize(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.state = FeishuBindingsFileSchema.parse(raw) as FeishuBindingsFile;
      if (process.platform !== "win32") {
        await chmod(this.filePath, 0o600);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Invalid Feishu binding store", { cause: error });
      }
    }
    this.initialized = true;
  }

  isOperational(): boolean {
    return this.initialized;
  }

  get(scopeKey: string): FeishuSessionBinding | undefined {
    this.assertInitialized();
    const binding = this.state.bindings.find(
      (item) => item.scopeKey === scopeKey,
    );
    return binding ? structuredClone(binding) : undefined;
  }

  list(): FeishuSessionBinding[] {
    this.assertInitialized();
    return structuredClone(this.state.bindings);
  }

  async upsert(input: FeishuSessionBinding): Promise<FeishuSessionBinding> {
    this.assertInitialized();
    const binding = FeishuSessionBindingSchema.parse(
      input,
    ) as FeishuSessionBinding;
    await this.enqueueWrite(async () => {
      const bindings = [...this.state.bindings];
      const index = bindings.findIndex(
        (item) => item.scopeKey === binding.scopeKey,
      );
      if (index === -1) bindings.push(binding);
      else bindings[index] = binding;
      await this.save({ version: 1, bindings });
    });
    return structuredClone(binding);
  }

  async remove(scopeKey: string): Promise<boolean> {
    this.assertInitialized();
    let removed = false;
    await this.enqueueWrite(async () => {
      const bindings = this.state.bindings.filter(
        (item) => item.scopeKey !== scopeKey,
      );
      if (bindings.length === this.state.bindings.length) return;
      await this.save({ version: 1, bindings });
      removed = true;
    });
    return removed;
  }

  /** Remove a binding only while the caller still owns the expected session. */
  async removeIfSession(
    scopeKey: string,
    expectedSessionId: string,
  ): Promise<boolean> {
    this.assertInitialized();
    let removed = false;
    await this.enqueueWrite(async () => {
      const index = this.state.bindings.findIndex(
        (item) =>
          item.scopeKey === scopeKey && item.sessionId === expectedSessionId,
      );
      if (index === -1) return;
      const bindings = [...this.state.bindings];
      bindings.splice(index, 1);
      await this.save({ version: 1, bindings });
      removed = true;
    });
    return removed;
  }

  async remapSessionId(
    oldSessionId: string,
    newSessionId: string,
  ): Promise<number> {
    this.assertInitialized();
    if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) {
      return 0;
    }
    let updated = 0;
    await this.enqueueWrite(async () => {
      const now = new Date().toISOString();
      const bindings = this.state.bindings.map((binding) => {
        if (binding.sessionId !== oldSessionId) return binding;
        updated += 1;
        return { ...binding, sessionId: newSessionId, updatedAt: now };
      });
      if (updated > 0) await this.save({ version: 1, bindings });
    });
    return updated;
  }

  private async save(nextState: FeishuBindingsFile): Promise<void> {
    await atomicWriteJson(this.filePath, nextState);
    this.state = nextState;
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const write = this.writeChain.then(operation);
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("FeishuBindingStore is not initialized");
    }
  }
}
