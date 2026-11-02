import { open, readFile, rename, lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import path from "node:path";
import { withFileLock } from "./file-lock.js";

export async function readEnv(file) {
  try {
    return parseEnv(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw Error("Unable to read credentials");
  }
}
export async function atomicPrivateFile(file, content) {
  try {
    if ((await lstat(file)).isSymbolicLink())
      throw Error("Refusing symlink file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = file + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export async function saveEnv(file, values, { lease } = {}) {
  const absolute = path.resolve(file);
  if (!lease)
    return withFileLock(absolute, (held) =>
      saveEnv(absolute, values, { lease: held }),
    );
  if (!lease.active || lease.file !== absolute)
    throw Error("Credential lock required");
  let content;
  try {
    content = await readFile(absolute, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") content = "";
    else throw error;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z_]+$/.test(key) || /[\r\n]/.test(String(value)))
      throw Error("Invalid env value");
    const line = `${key}=${JSON.stringify(String(value))}`;
    const pattern = new RegExp("^" + key + "=.*$", "m");
    content = pattern.test(content)
      ? content.replace(pattern, () => line)
      : content.replace(/\n?$/, "\n") + line + "\n";
  }
  await atomicPrivateFile(absolute, content);
}
