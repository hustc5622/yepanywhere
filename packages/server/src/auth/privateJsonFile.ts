import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  OWNER_READ_WRITE_FILE_MODE,
  enforceOwnerReadWriteFilePermissions,
} from "../utils/filePermissions.js";

export async function writePrivateJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: fs.FileHandle | undefined;

  try {
    handle = await fs.open(tempPath, "wx", OWNER_READ_WRITE_FILE_MODE);
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await enforceOwnerReadWriteFilePermissions(tempPath, "[auth]");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
