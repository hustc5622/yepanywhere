import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type FeishuSecretRef,
  FeishuSecretRefSchema,
  type FeishuSecretStatus,
} from "@yep-anywhere/shared";
import { z } from "zod";
import { atomicWriteJson } from "../../utils/atomic-json-file.js";

const FeishuSecretsFileSchema = z.object({
  version: z.literal(1),
  secrets: z.record(z.string(), z.string().min(1)),
});

type FeishuSecretsFile = z.infer<typeof FeishuSecretsFileSchema>;

export interface FeishuSecretStoreOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
}

export class FeishuSecretStore {
  readonly filePath: string;
  private readonly env: NodeJS.ProcessEnv;
  private state: FeishuSecretsFile = { version: 1, secrets: {} };
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: FeishuSecretStoreOptions) {
    this.filePath = join(options.dataDir, "channels", "feishu", "secrets.json");
    this.env = options.env ?? process.env;
  }

  async initialize(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.state = FeishuSecretsFileSchema.parse(raw);
      if (process.platform !== "win32") {
        await chmod(this.filePath, 0o600);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Invalid Feishu secret store", { cause: error });
      }
    }
    this.initialized = true;
  }

  async set(accountId: string, secret: string): Promise<FeishuSecretRef> {
    this.assertInitialized();
    const ref = FeishuSecretRefSchema.parse(`store:${accountId}`);
    if (!secret.trim()) {
      throw new Error("Feishu App Secret must not be empty");
    }

    await this.enqueueWrite(async () => {
      const nextState: FeishuSecretsFile = {
        version: 1,
        secrets: { ...this.state.secrets, [accountId]: secret },
      };
      await atomicWriteJson(this.filePath, nextState);
      this.state = nextState;
    });
    return ref;
  }

  async remove(accountId: string): Promise<boolean> {
    this.assertInitialized();
    let removed = false;
    await this.enqueueWrite(async () => {
      if (!(accountId in this.state.secrets)) {
        return;
      }
      const secrets = { ...this.state.secrets };
      delete secrets[accountId];
      const nextState: FeishuSecretsFile = { version: 1, secrets };
      await atomicWriteJson(this.filePath, nextState);
      this.state = nextState;
      removed = true;
    });
    return removed;
  }

  resolve(secretRef: string): string | undefined {
    this.assertInitialized();
    const parsed = FeishuSecretRefSchema.safeParse(secretRef);
    if (!parsed.success) {
      return undefined;
    }
    const [source, key] = parsed.data.split(":", 2) as [
      "store" | "env",
      string,
    ];
    return source === "store" ? this.state.secrets[key] : this.env[key];
  }

  describe(secretRef: string): FeishuSecretStatus {
    this.assertInitialized();
    const parsed = FeishuSecretRefSchema.safeParse(secretRef);
    if (!parsed.success) {
      return { configured: false, source: "unknown" };
    }
    const source = parsed.data.startsWith("store:") ? "store" : "env";
    const value = this.resolve(parsed.data);
    return value
      ? { configured: true, source, value }
      : { configured: false, source };
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const write = this.writeChain.then(operation);
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("FeishuSecretStore is not initialized");
    }
  }
}
