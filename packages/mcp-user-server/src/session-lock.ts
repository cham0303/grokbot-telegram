import { chmodSync, closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { ToolFailure } from "./tool-error.js";

const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_STALE_MS = 15_000;

export type SessionLockOptions = {
  waitMs?: number;
  staleMs?: number;
};

function lockPathFor(sessionPath: string): string {
  return `${sessionPath}.lock`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Exclusive create so two processes cannot both believe they own the write.
// A lock left by a dead process is removed once it is older than staleMs.
function acquire(sessionPath: string, options: SessionLockOptions): number {
  const dir = dirname(sessionPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Directory exists but cannot be chmod'd.
  }
  const path = lockPathFor(sessionPath);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      return fd;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      try {
        const st = statSync(path);
        if (Date.now() - st.mtimeMs >= staleMs) unlinkSync(path);
      } catch {
        // The holder removed it between stat and unlink. Try again.
      }
      if (Date.now() - started >= waitMs) {
        throw new ToolFailure(
          "timeout",
          "Timed out waiting for the session file lock. The session file was not changed.",
        );
      }
      sleepSync(20);
    }
  }
}

export function withSessionFileLockSync(
  sessionPath: string,
  fn: () => void,
  options: SessionLockOptions = {},
): void {
  const fd = acquire(sessionPath, options);
  try {
    fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    try {
      unlinkSync(lockPathFor(sessionPath));
    } catch {
      // Another writer may have replaced a stale lock. The file write already
      // finished or threw before we got here.
    }
  }
}
