import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../../../utils/atomic-json-file.js";
import { isFileLocked, withFileLock } from "../../../utils/fileLock.js";

export const GrantSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessExpiresAt: z.number(),
  refreshExpiresAt: z.number(),
  scopes: z.array(z.string()),
  revision: z.number(),
  authorizedAt: z.number().optional(),
  lastRefreshedAt: z.number(),
  nextRefreshAt: z.number(),
  status: z.enum([
    "ready",
    "retrying",
    "reauth_required",
    "config_error",
    "refresh_uncertain",
  ]),
  lastError: z.string().optional(),
  refreshStartedAt: z.number().optional(),
  failures: z.number().default(0),
});
const AttemptSchema = z.object({
  state: z.string(),
  verifier: z.string(),
  url: z.string(),
  expiresAt: z.number(),
  redirectUri: z.string(),
  scopes: z.array(z.string()),
  consumed: z.boolean().default(false),
});
export const AuthRecordSchema = z.object({
  version: z.literal(1),
  accountId: z.string(),
  appId: z.string(),
  domain: z.enum(["feishu", "lark"]),
  userOpenId: z.string(),
  suppressedUntil: z.number().optional(),
  cancelVersion: z.number().default(0),
  grant: GrantSchema.optional(),
  attempt: AttemptSchema.optional(),
});
export type AuthRecord = z.infer<typeof AuthRecordSchema>;
export type Grant = z.infer<typeof GrantSchema>;
export function grantKey(domain: string, appId: string, user: string) {
  return createHash("sha256")
    .update(JSON.stringify([domain, appId, user]))
    .digest("hex");
}

/** No in-memory token cache: every lock holder observes the latest committed revision. */
export class FeishuUserGrantStore {
  readonly directory: string;
  constructor(dataDir: string) {
    this.directory = join(dataDir, "channels", "feishu", "user-auth");
  }
  private path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid grant key");
    return join(this.directory, `${key}.json`);
  }
  async read(key: string): Promise<AuthRecord | undefined> {
    try {
      return AuthRecordSchema.parse(
        JSON.parse(await readFile(this.path(key), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async write(key: string, record: AuthRecord) {
    await atomicWriteJson(this.path(key), AuthRecordSchema.parse(record));
  }
  async isRefreshing(key: string) {
    return isFileLocked(`${this.path(key)}.sentinel`);
  }
  async locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const sentinel = `${this.path(key)}.sentinel`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(sentinel, "", { flag: "wx", mode: 0o600 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    return withFileLock(sentinel, operation, { stale: 60_000, retries: 6 });
  }
}
