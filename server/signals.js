const POLL_MS = 30000;
const LIMIT = 2000;
const MAX_MESSAGES = 10000;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const bounded = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;

/** Observed Twitch signals use verified live timestamps, never the application's startup clock. */
export class TwitchSignals {
  constructor({ engine, api, env = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { engine, api, env, now, setTimer, clearTimer });
    this.enabled = env.TWITCH_CONNECT === 'true' && env.TWITCH_SIGNALS === 'true';
    this.running = false;
    this.generation = 0;
    this.nextPollAt = -Infinity;
    this.seenClips = new Set();
    this.seenChat = new Set();
    this.messages = [];
    this.viewers = new Map();
    this.milestones = new Set();
    this.blockedStreams = new Set();
    this.stats = { polls: 0, errors: 0, emitted: 0 };
    this.status = this.enabled ? 'idle' : 'disabled';
    this.lastSpikeAt = -Infinity;
  }
  config() { return this.engine.config ?? {}; }
  state() {
    return { enabled: this.enabled, status: this.status, streamId: this.stream?.id ?? null,
      startedAt: this.stream?.started_at ?? null, verified: !!this.verified,
      clipBaseline: this.clipBaselineAt !== undefined, bufferedMessages: this.messages.length,
      ...this.stats };
  }
  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.status = 'checking';
    this.schedule();
  }
  schedule() {
    if (!this.running || this.timer || this.polling) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.poll();
    }, Math.max(0, this.nextPollAt - this.now()));
    this.timer?.unref?.();
  }
  async poll() {
    if (!this.running || this.polling) return;
    if (this.now() < this.nextPollAt) { this.schedule(); return; }
    const generation = this.generation;
    this.polling = true;
    this.nextPollAt = this.now() + POLL_MS;
    this.stats.polls++;
    try {
      const channel = this.env.TWITCH_BROADCASTER_ID;
      if (!/^\d{1,30}$/.test(channel ?? '')) throw Error('Channel is not configured');
      const response = await this.api.request('/streams?' + new URLSearchParams({ user_id: channel }));
      if (!this.running || generation !== this.generation) return;
      if (!Array.isArray(response?.data)) throw Error('Invalid live response');
      const stream = response.data.find(item => item.user_id === channel);
      if (!stream) {
        this.resetStream();
        this.status = 'offline';
        return;
      }
      const started = typeof stream.started_at === 'string' ? Date.parse(stream.started_at) : NaN;
      // Offline can arrive before the first /streams response reveals the ended id.
      // A delayed online hint cannot prove that an unknown stream is newer than offline.
      const fenced = this.blockedStreams.has(stream.id) ||
        (this.offlineAt !== undefined && started <= this.offlineAt);
      if (!validId(stream.id) || !Number.isFinite(started) || started > this.now() || fenced) {
        this.verified = false;
        this.status = fenced ? 'offline' : 'unverified';
        return;
      }
      if (this.stream?.id !== stream.id) {
        this.resetStream();
        this.stream = { id: stream.id, started_at: stream.started_at, started };
      }
      this.verified = true;
      this.verifiedAt = this.now();
      this.status = 'live';
      for (const moment of this.config().moments ?? []) {
        const trigger = moment.trigger;
        if (moment.kind !== 'twitch' || trigger?.type !== 'stream_minutes' ||
            !validId(moment.id) || !bounded(trigger.minutes, 1, 1440)) continue;
        const eventId = `twitch:${stream.id}:minutes:${moment.id}`;
        if (this.milestones.has(eventId) || this.now() - started < trigger.minutes * 60000) continue;
        // A late startup declares at observation time. It does not backdate the occurrence.
        if (await this.emit(moment.id, { eventId, stream_id: stream.id, minutes: trigger.minutes }))
          this.milestones.add(eventId);
        if (!this.running || generation !== this.generation) return;
      }
      if (this.config().signals?.clip_poll_enabled === true && this.hasMoment('clip-created'))
        await this.clips(generation);
    } catch {
      if (this.running && generation === this.generation) {
        this.verified = false;
        this.status = 'degraded';
        this.stats.errors++;
      }
    } finally {
      this.polling = false;
      this.schedule();
    }
  }
  hasMoment(id) { return (this.config().moments ?? []).some(moment => moment.id === id && moment.kind === 'twitch'); }
  async emit(moment, context) {
    try {
      await this.engine.occur(moment, { source: 'twitch', ...context }, 'twitch');
      this.stats.emitted++;
      return true;
    } catch {
      this.stats.errors++;
      return false;
    }
  }
  async clips(generation) {
    const stream = this.stream;
    const response = await this.api.request('/clips?' + new URLSearchParams({
      broadcaster_id: this.env.TWITCH_BROADCASTER_ID, started_at: stream.started_at, first: '100',
    }));
    if (!this.running || generation !== this.generation || this.stream?.id !== stream.id || !this.verified) return;
    if (!Array.isArray(response?.data)) throw Error('Invalid clips response');
    const clips = response.data.slice(0, 100).filter(clip => validId(clip.id) &&
      clip.broadcaster_id === this.env.TWITCH_BROADCASTER_ID &&
      Number.isFinite(Date.parse(clip.created_at)) && Date.parse(clip.created_at) >= stream.started &&
      Date.parse(clip.created_at) <= this.now());
    const baseline = this.clipBaselineAt === undefined;
    if (baseline) this.clipBaselineAt = this.now();
    for (const clip of clips) {
      if (this.seenClips.has(clip.id)) continue;
      this.seenClips.add(clip.id);
      if (this.seenClips.size > LIMIT) this.seenClips.delete(this.seenClips.values().next().value);
      // Older clips returned late are not new creations. Baseline contains no historical reveals.
      if (baseline || Date.parse(clip.created_at) < this.clipBaselineAt) continue;
      await this.emit('clip-created', { eventId: `twitch:${stream.id}:clip:${clip.id}`,
        stream_id: stream.id, clip_id: clip.id });
      if (!this.running || generation !== this.generation) return;
    }
  }
  async chat(event, id) {
    if (!this.running || !this.verified || this.status !== 'live' ||
        this.now() - this.verifiedAt > POLL_MS * 2 || !validId(id) || this.seenChat.has(id) ||
        event?.broadcaster_user_id !== this.env.TWITCH_BROADCASTER_ID ||
        (event.source_broadcaster_user_id && event.source_broadcaster_user_id !== this.env.TWITCH_BROADCASTER_ID) ||
        typeof event.chatter_user_id !== 'string' || !/^\d{1,30}$/.test(event.chatter_user_id)) return;
    const config = this.config().signals?.chat_spike;
    if (!config?.enabled || !this.hasMoment('chat-spike') ||
        !bounded(config.window_seconds, 1, 300) || !bounded(config.min_messages, 1, MAX_MESSAGES) ||
        !bounded(config.min_viewers, 1, LIMIT) || !bounded(config.cooldown_seconds, 1, 3600)) return;
    this.seenChat.add(id);
    if (this.seenChat.size > MAX_MESSAGES) this.seenChat.delete(this.seenChat.values().next().value);
    const at = this.now(), cutoff = at - config.window_seconds * 1000;
    this.messages = this.messages.filter(timestamp => timestamp > cutoff);
    this.messages.push(at);
    if (this.messages.length > MAX_MESSAGES) this.messages.shift();
    for (const [user, lastAt] of this.viewers) if (lastAt <= cutoff) this.viewers.delete(user);
    this.viewers.delete(event.chatter_user_id);
    this.viewers.set(event.chatter_user_id, at);
    if (this.viewers.size > LIMIT) this.viewers.delete(this.viewers.keys().next().value);
    const viewers = this.viewers.size;
    if (this.messages.length < config.min_messages || viewers < config.min_viewers ||
        at - this.lastSpikeAt < config.cooldown_seconds * 1000) return;
    this.lastSpikeAt = at;
    await this.emit('chat-spike', { eventId: `twitch:${this.stream.id}:chat-spike:${id}`,
      stream_id: this.stream.id, messages: this.messages.length, viewers, window_seconds: config.window_seconds });
    this.messages = [];
    this.viewers.clear();
  }
  online(event) {
    if (!this.running) return;
    // EventSub is a hint. Helix still must verify both the stream id and started_at.
    if (event?.broadcaster_user_id !== this.env.TWITCH_BROADCASTER_ID || !validId(event.id)) return;
    // A delayed online notification for an ended stream must not undo the offline fence.
    this.schedule();
  }
  resetStream() {
    this.stream = null;
    this.verified = false;
    this.clipBaselineAt = undefined;
    this.seenClips.clear();
    this.seenChat.clear();
    this.messages = [];
    this.viewers.clear();
    this.milestones.clear();
    this.lastSpikeAt = -Infinity;
  }
  offline() {
    if (!this.running) return;
    // Preserve this fence across resets, even when no stream id has been verified yet.
    this.offlineAt = Math.max(this.offlineAt ?? -Infinity, this.now());
    if (this.stream) {
      this.blockedStreams.add(this.stream.id);
      if (this.blockedStreams.size > 256) this.blockedStreams.delete(this.blockedStreams.values().next().value);
    }
    this.generation++;
    this.resetStream();
    this.status = 'offline';
  }
  close() {
    this.running = false;
    this.generation++;
    this.clearTimer(this.timer);
    this.timer = null;
    this.resetStream();
    this.status = this.enabled ? 'closed' : 'disabled';
  }
}
