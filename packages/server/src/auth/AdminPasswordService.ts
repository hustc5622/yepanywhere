import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import bcrypt from "bcrypt";
import { AUTH_ERROR_CODES, AuthError } from "./authErrors.js";
import { writePrivateJsonAtomic } from "./privateJsonFile.js";

const BCRYPT_ROUNDS = 12;

interface AdminPasswordState {
  version: 1;
  passwordHash: string;
}

export interface AdminPasswordServiceOptions {
  filePath?: string;
}

export class AdminPasswordService {
  private readonly filePath: string;

  static getDefaultFilePath(): string {
    return path.join(os.homedir(), ".yep-anywhere", "admin.json");
  }

  constructor(options: AdminPasswordServiceOptions = {}) {
    this.filePath =
      options.filePath ?? AdminPasswordService.getDefaultFilePath();
  }

  getFilePath(): string {
    return this.filePath;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.readState()) !== undefined;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const state = await this.readState();
    return state ? bcrypt.compare(password, state.passwordHash) : false;
  }

  async setPassword(newPassword: string): Promise<void> {
    if (newPassword.length < 6) {
      throw new AuthError(
        AUTH_ERROR_CODES.passwordInvalid,
        "Password must be at least 6 characters",
      );
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await writePrivateJsonAtomic(this.filePath, { version: 1, passwordHash });
    } catch (error) {
      throw new AuthError(
        AUTH_ERROR_CODES.configError,
        "Administrator password configuration could not be saved",
        { cause: error },
      );
    }
  }

  private async readState(): Promise<AdminPasswordState | undefined> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(content);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== 1 ||
        typeof (parsed as { passwordHash?: unknown }).passwordHash !==
          "string" ||
        (parsed as { passwordHash: string }).passwordHash.length === 0
      ) {
        throw new Error("Invalid administrator password configuration");
      }
      return parsed as AdminPasswordState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new AuthError(
        AUTH_ERROR_CODES.configError,
        "Administrator password configuration could not be read",
        { cause: error },
      );
    }
  }
}
