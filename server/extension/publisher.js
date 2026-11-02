import { signExtensionJWT } from "./auth.js";

/** One shared channel budget for snapshots AND whispers, never per-frame traffic. */
export class ExtensionPublisher {
  constructor({
    secret,
    clientId,
    ownerId,
    channelId,
    fetcher = fetch,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    Object.assign(this, {
      secret,
      clientId,
      ownerId,
      channelId,
      fetcher,
      now,
      setTimer,
      clearTimer,
    });
    this.nextAt = 0;
    this.whispers = new Map();
    this.stats = { sent: 0, failed: 0 };
  }
  snapshot(snapshot) {
    const text = JSON.stringify(snapshot);
    if (text === this.lastSnapshot) return;
    this.lastSnapshot = text;
    this.pending = { target: "broadcast", message: text };
    this.schedule();
  }
  whisper(opaqueId, result) {
    if (!/^[UA][A-Za-z0-9_-]{1,79}$/.test(opaqueId) || this.whispers.size >= 32)
      return;
    this.whispers.set(opaqueId, {
      target: "whisper-" + opaqueId,
      message: JSON.stringify(result),
    });
    this.schedule();
  }
  schedule() {
    if (
      this.closed ||
      this.timer ||
      this.busy ||
      (!this.pending && !this.whispers.size)
    )
      return;
    this.timer = this.setTimer(
      () => {
        this.timer = null;
        void this.flush();
      },
      Math.max(0, this.nextAt - this.now()),
    );
    this.timer.unref?.();
  }
  async flush() {
    if (this.closed || this.busy) return;
    const entry = this.pending || this.whispers.values().next().value;
    if (!entry) return;
    if (this.pending) this.pending = null;
    else this.whispers.delete(entry.target.slice("whisper-".length));
    this.busy = true;
    this.nextAt = this.now() + 1000;
    try {
      if (Buffer.byteLength(entry.message) > 4096)
        throw Error("Snapshot too large");
      const jwt = signExtensionJWT(
        {
          exp: Math.floor(this.now() / 1000) + 60,
          role: "external",
          user_id: this.ownerId,
          channel_id: this.channelId,
          pubsub_perms: { send: [entry.target] },
        },
        this.secret,
      );
      const response = await this.fetcher(
        "https://api.twitch.tv/helix/extensions/pubsub",
        {
          method: "POST",
          headers: {
            "Client-Id": this.clientId,
            Authorization: "Bearer " + jwt,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            broadcaster_id: this.channelId,
            target: [entry.target],
            message: entry.message,
          }),
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!response.ok) throw Error("PubSub unavailable");
      this.stats.sent++;
    } catch {
      // The authenticated state/result fetch remains available; never log HTTP bodies or JWTs.
      this.stats.failed++;
      this.nextAt = this.now() + 2000;
    } finally {
      this.busy = false;
      this.schedule();
    }
  }
  close() {
    this.closed = true;
    this.clearTimer(this.timer);
    this.whispers.clear();
    this.pending = null;
  }
}
