import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withFileLock } from "./file-lock.js";
import { atomicPrivateFile, readEnv, saveEnv } from "./env-store.js";
import { TwitchAuthLog, tokenDigest } from "./twitch-auth-log.js";

const keys = [
  "TWITCH_TOKEN",
  "TWITCH_REFRESH_TOKEN",
  "TWITCH_CLIENT_ID",
  "TWITCH_USER_ID",
  "TWITCH_BROADCASTER_ID",
  "TWITCH_EXPIRES_AT",
  "TWITCH_SCOPES",
];
export class TwitchAuthError extends Error {
  constructor(reason = "reauthorization-required", httpStatus = null) {
    super("Twitch needs re-authorization");
    this.code = "reauthorization-required";
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}
export class TwitchCredentials {
  constructor(
    file,
    {
      journal = new TwitchAuthLog(
        path.join(path.dirname(file), "runs/twitch-auth.jsonl"),
      ),
      now = Date.now,
    } = {},
  ) {
    this.now = now;
    this.file = path.resolve(file);
    this.pending = this.file + ".twitch-refresh.json";
    this.journal = journal;
  }
  async load(env) {
    return withFileLock(this.file, async () => {
      this.adopt(env, await readEnv(this.file));
      const marker = await this.marker();
      if (
        marker?.refresh_digest === tokenDigest(env.TWITCH_REFRESH_TOKEN) &&
        (!marker.access_digest ||
          marker.access_digest === tokenDigest(env.TWITCH_TOKEN))
      )
        throw new TwitchAuthError("refresh-outcome-uncertain");
      if (marker) await this.clear();
      return env;
    });
  }
  adopt(env, saved) {
    for (const key of keys) if (saved[key] !== undefined) env[key] = saved[key];
    return env;
  }
  async marker() {
    try {
      return JSON.parse(await readFile(this.pending, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new TwitchAuthError("invalid-refresh-journal");
    }
  }
  async clear() {
    await unlink(this.pending).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async install(values, { trigger = "device", expiresIn } = {}) {
    try {
      return await withFileLock(this.file, async (lease) => {
        await saveEnv(this.file, values, { lease });
        await this.clear();
        await this.journal.write("persist", values, {
          trigger,
          phase: "committed",
          expires_in: expiresIn,
          refresh_returned: !!values.TWITCH_REFRESH_TOKEN,
        });
      });
    } catch {
      await this.journal.write("failure", values, {
        trigger,
        reason: "credential-save-failed",
      });
      throw new TwitchAuthError("credential-save-failed");
    }
  }

  async refresh(env, expectedAccess, trigger, exchange) {
    return withFileLock(this.file, async (lease) => {
      const previous = { ...env };
      this.adopt(env, await readEnv(this.file));
      const marker = await this.marker();
      if (
        marker &&
        marker.refresh_digest === tokenDigest(env.TWITCH_REFRESH_TOKEN) &&
        (!marker.access_digest ||
          marker.access_digest === tokenDigest(env.TWITCH_TOKEN))
      ) {
        await this.journal.write("failure", env, {
          trigger,
          attempt: marker.attempt,
          reason: "refresh-outcome-uncertain",
        });
        throw new TwitchAuthError("refresh-outcome-uncertain");
      }
      if (marker) await this.clear();
      if (env.TWITCH_TOKEN !== expectedAccess) {
        await this.journal.write("refresh", env, {
          trigger,
          phase: "peer-adopted",
          previous,
        });
        return { reused: true };
      }
      if (!env.TWITCH_REFRESH_TOKEN)
        throw new TwitchAuthError("missing-refresh-token");
      const attempt = randomUUID();
      await atomicPrivateFile(
        this.pending,
        JSON.stringify({
          attempt,
          refresh_digest: tokenDigest(env.TWITCH_REFRESH_TOKEN),
          access_digest: tokenDigest(env.TWITCH_TOKEN),
          timestamp: new Date().toISOString(),
        }),
      );
      const data = await exchange(attempt);
      const values = {
        TWITCH_TOKEN: data.access_token,
        TWITCH_REFRESH_TOKEN: data.refresh_token || "",
      };
      if (Number.isFinite(data.expires_in))
        values.TWITCH_EXPIRES_AT = String(this.now() + data.expires_in * 1000);
      if (Array.isArray(data.scope))
        values.TWITCH_SCOPES = data.scope.join(" ");
      try {
        await saveEnv(this.file, values, { lease });
      } catch {
        await this.journal.write(
          "failure",
          { ...env, ...values },
          { trigger, attempt, reason: "refresh-save-failed", previous },
        );
        throw new TwitchAuthError("refresh-save-failed");
      }
      this.adopt(env, values);
      await this.journal.write("persist", env, {
        trigger,
        phase: "committed",
        attempt,
        expires_in: data.expires_in,
        refresh_returned: !!data.refresh_token,
        refresh_rotated:
          !!data.refresh_token &&
          data.refresh_token !== previous.TWITCH_REFRESH_TOKEN,
        previous,
      });
      await this.clear();
      return { reused: false, expires_in: data.expires_in };
    });
  }
}
