import { spawn } from "node:child_process";
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** Kernel-managed advisory lock; no PID guessing or stale-file unlink race. */
export async function withFileLock(file, operation) {
  const lockFile = path.resolve(file) + ".lock";
  try {
    if ((await lstat(lockFile)).isSymbolicLink())
      throw Error("Unsafe lock file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const handle = await open(
    lockFile,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  await handle.chmod(0o600);
  await handle.close();
  const child = spawn(
    "flock",
    [
      "--exclusive",
      "--timeout",
      "15",
      lockFile,
      process.execPath,
      path.join(import.meta.dirname, "lock-holder.mjs"),
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH },
    },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(Error("Credential lock unavailable"));
        else resolve();
      };
      child.once("error", () => finish(true));
      child.once("exit", () => finish(true));
      child.stdout.once("data", (data) =>
        finish(String(data).trim() !== "locked"),
      );
      child.stdin.on("error", () => {});
    });
    const lease = { file: path.resolve(file), active: true };
    try {
      return await operation(lease);
    } finally {
      lease.active = false;
    }
  } finally {
    child.stdin.end();
    await closed;
  }
}
