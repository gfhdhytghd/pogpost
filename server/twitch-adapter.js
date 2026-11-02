import { connectTwitch } from "./twitch.js";
import { TwitchAPI } from "./twitch-api.js";
import path from "node:path";
import { TwitchSignals } from "./signals.js";

const MOMENTS = { "channel.raid": "raid", "channel.poll.end": "poll-ended",
  "channel.follow": "new-follower", "channel.subscribe": "new-sub" };
const eventId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;

/** No chat replies contain note content. Stream lifecycle notifications never reveal or wrap notes. */
export function createTwitchAdapter(engine, env = {}, {
  api = new TwitchAPI(env, { envFile: path.resolve(import.meta.dirname, "../.env") }),
  socketFactory, logger = console, onRedemption = async () => {},
  signalsOptions = {}, ...options
} = {}) {
  let current = { connection: "disabled", subscriptions: {}, stream: "unknown" };
  const signals = new TwitchSignals({ engine, api, env, ...signalsOptions });
  signals.start();
  const seen = new Set();
  const streamIds = new Set();
  async function onEvent({ type, id, event }) {
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    if (type === "stream.offline") { current.stream = "offline"; signals.offline(); return; }
    if (type === "stream.online") {
      current.stream = "online";
      signals.online(event);
      // Default is explicit operator session management. Opt-in starts once per observed stream id.
      if (env.TWITCH_AUTO_SESSION === "true" && eventId(event.id) && !streamIds.has(event.id)) {
        streamIds.add(event.id);
        if (streamIds.size > 256) streamIds.delete(streamIds.values().next().value);
        await engine.newSession();
      }
      return;
    }
    if (MOMENTS[type]) {
      const context = { source: "twitch", eventId: id };
      if (type === "channel.raid" && Number.isSafeInteger(event.viewers) && event.viewers >= 0)
        context.viewers = event.viewers;
      if (type === "channel.poll.end") context.pollId = eventId(event.id);
      await engine.occur(MOMENTS[type], context, "twitch");
    } else if (type === "channel.chat.message") {
      // Counting chat must not delay the authenticated command relative to later EventSub events.
      void signals.chat(event, id).catch(() => {});
      const role = event.badges?.some(badge => badge.set_id === "broadcaster") ? "broadcaster"
        : event.badges?.some(badge => badge.set_id === "moderator") ? "moderator" : null;
      const match = typeof event.message?.text === "string"
        ? /^!moment\s+([a-z0-9][a-z0-9_-]{0,63})\s*$/i.exec(event.message.text) : null;
      if (!role || !match) return;
      // Broadcaster badges must also match the channel owner id.
      if (role === "broadcaster" && event.chatter_user_id !== env.TWITCH_BROADCASTER_ID) return;
      await engine.occur(match[1].toLowerCase(), { source: "chat", eventId: id }, role);
    } else if (type === "channel.channel_points_custom_reward_redemption.add" &&
      env.PAYMENTS_LIVE === "true" && event.reward?.id === env.TWITCH_REWARD_ID) {
      await onRedemption({ id: eventId(event.id), user_id: event.user_id,
        broadcaster_user_id: event.broadcaster_user_id, status: event.status,
        reward: { id: event.reward.id, cost: event.reward.cost } });
    }
  }
  const connection = env.TWITCH_CONNECT === "true" ? connectTwitch(onEvent, env, {
    ...options, api, socketFactory, logger,
    onStatus(status) { current = { ...current, ...status }; },
  }) : null;
  return { api, signals, state: () => ({ ...structuredClone(current), signals: signals.state() }),
    close() { connection?.close(); signals.close(); } };
}
