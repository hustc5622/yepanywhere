import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type FeishuAccountConfig,
  FeishuAccountConfigSchema,
  type FeishuAccountsFile,
  FeishuAccountsFileSchema,
} from "@yep-anywhere/shared";
import { atomicWriteJson } from "../../utils/atomic-json-file.js";

export interface FeishuAccountConfigStoreOptions {
  dataDir: string;
}

export class FeishuAccountConfigStore {
  readonly filePath: string;
  private state: FeishuAccountsFile = { version: 1, accounts: [] };
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: FeishuAccountConfigStoreOptions) {
    this.filePath = join(
      options.dataDir,
      "channels",
      "feishu",
      "accounts.json",
    );
  }

  async initialize(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.state = FeishuAccountsFileSchema.parse(raw);
      if (process.platform !== "win32") {
        await chmod(this.filePath, 0o600);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("Invalid Feishu account configuration", {
          cause: error,
        });
      }
    }
    this.initialized = true;
  }

  list(): FeishuAccountConfig[] {
    this.assertInitialized();
    return structuredClone(this.state.accounts);
  }

  get(accountId: string): FeishuAccountConfig | undefined {
    this.assertInitialized();
    const account = this.state.accounts.find((item) => item.id === accountId);
    return account ? structuredClone(account) : undefined;
  }

  async upsert(input: FeishuAccountConfig): Promise<FeishuAccountConfig> {
    this.assertInitialized();
    const account = FeishuAccountConfigSchema.parse(input);
    await this.enqueueWrite(async () => {
      const index = this.state.accounts.findIndex(
        (item) => item.id === account.id,
      );
      const accounts = [...this.state.accounts];
      if (index === -1) {
        accounts.push(account);
      } else {
        accounts[index] = account;
      }
      const nextState: FeishuAccountsFile = { version: 1, accounts };
      await atomicWriteJson(this.filePath, nextState);
      this.state = nextState;
    });
    return structuredClone(account);
  }

  async remove(accountId: string): Promise<boolean> {
    this.assertInitialized();
    let removed = false;
    await this.enqueueWrite(async () => {
      const accounts = this.state.accounts.filter(
        (item) => item.id !== accountId,
      );
      if (accounts.length === this.state.accounts.length) {
        return;
      }
      const nextState: FeishuAccountsFile = { version: 1, accounts };
      await atomicWriteJson(this.filePath, nextState);
      this.state = nextState;
      removed = true;
    });
    return removed;
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const write = this.writeChain.then(operation);
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("FeishuAccountConfigStore is not initialized");
    }
  }
}
