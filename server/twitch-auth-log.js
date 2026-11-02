import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

export const tokenDigest = (value) =>
  value ? createHash("sha256").update(String(value)).digest("hex") : null;
export const tokenHash = (value) => tokenDigest(value)?.slice(0, 8) || null;
const reasons = new Set([
  "refresh-save-failed",
  "validation-unavailable",
  "identity-mismatch",
  "missing-refresh-token",
  "refresh-outcome-uncertain",
  "refresh-rejected",
  "invalid-refresh-response",
  "validation-rejected",
  "missing-rotated-refresh-token",
  "invalid-refresh-journal",
  "device-identity-rejected",
  "device-authorization-failed",
  "api-unavailable",
  "api-rejected",
  "credential-save-failed",
]);
const phases = new Set([
  "request",
  "response",
  "committed",
  "peer-adopted",
  "complete",
]);
const events = new Set(["validate", "refresh", "persist", "failure", "device"]);
const triggers = new Set([
  "startup",
  "hourly",
  "401",
  "expiry",
  "manual",
  "device",
  "peer",
]);

/** Explicit allowlist: raw HTTP bodies, exceptions and tokens never reach the journal. */
export class TwitchAuthLog {
  constructor(
    file = path.resolve(import.meta.dirname, "../runs/twitch-auth.jsonl"),
  ) {
    this.file = file;
  }
  async write(event, env = {}, details = {}) {
    const row = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      event: events.has(event) ? event : "failure",
      trigger: triggers.has(details.trigger) ? details.trigger : "manual",
      phase: phases.has(details.phase) ? details.phase : "complete",
      http_status: Number.isInteger(details.http_status)
        ? details.http_status
        : null,
      expires_in: Number.isFinite(details.expires_in)
        ? details.expires_in
        : null,
      refresh_returned: details.refresh_returned === true,
      refresh_rotated: details.refresh_rotated === true,
      access_hash: tokenHash(env.TWITCH_TOKEN),
      refresh_hash: tokenHash(env.TWITCH_REFRESH_TOKEN),
      previous_access_hash: tokenHash(details.previous?.TWITCH_TOKEN),
      previous_refresh_hash: tokenHash(details.previous?.TWITCH_REFRESH_TOKEN),
      attempt: /^[a-f0-9-]{36}$/.test(details.attempt || "")
        ? details.attempt
        : null,
      reason: reasons.has(details.reason) ? details.reason : null,
    };
    await mkdir(path.dirname(this.file), { recursive: true });
    const handle = await open(this.file, "a", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(row) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
