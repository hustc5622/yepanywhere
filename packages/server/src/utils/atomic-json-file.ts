import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  chmod,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWriteText(
  filePath: string,
  content: string,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
  if (process.platform !== "win32") {
    await chmod(directory, OWNER_DIRECTORY_MODE);
  }

  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;

  try {
    handle = await open(tempPath, "wx", OWNER_FILE_MODE);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    await rename(tempPath, filePath);
    if (process.platform !== "win32") {
      await chmod(filePath, OWNER_FILE_MODE);
      await syncDirectory(directory);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
