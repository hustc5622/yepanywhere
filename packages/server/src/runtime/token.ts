import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TOKEN_BYTES = 32;

async function readRuntimeToken(tokenFile: string): Promise<string> {
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) {
    throw new Error(`Runtime token file is empty: ${tokenFile}`);
  }
  return token;
}

/**
 * Read or atomically create the localhost runtime bearer token.
 * The restrictive mode matters even though the control server only binds to
 * loopback: other local users must not be able to steer active sessions.
 */
export async function ensureRuntimeToken(tokenFile: string): Promise<string> {
  try {
    const token = await readRuntimeToken(tokenFile);
    await chmod(tokenFile, 0o600).catch(() => {});
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const token = randomBytes(TOKEN_BYTES).toString("base64url");

  try {
    await writeFile(tokenFile, `${token}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  // A concurrent runtime won the create race. Reuse its token.
  await chmod(tokenFile, 0o600).catch(() => {});
  return readRuntimeToken(tokenFile);
}
