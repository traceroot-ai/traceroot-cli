import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const SWALLOWED_CHMOD_CODES = new Set(["EPERM", "ENOSYS", "ENOTSUP"]);

/**
 * Atomically writes a secret-bearing file with restrictive (0600) permissions
 * where the platform supports it: parent directory created 0700, payload
 * written to a same-directory temp file, chmodded (tolerating win32 /
 * unsupported chmod), then renamed into place. On any failure the temp file is
 * cleaned up best-effort and the original error is rethrown — callers wrap it
 * in their own error type so no payload bytes reach a message.
 */
export function writeFileSecure(target: string, payload: string): void {
  const dir = dirname(target);
  const tmp = join(dir, `.${basename(target)}.${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, payload, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch (chmodErr) {
      const code = (chmodErr as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" && code !== undefined && !SWALLOWED_CHMOD_CODES.has(code)) {
        throw chmodErr;
      }
      // Best-effort on win32 / unsupported chmod: keep the written file.
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}
