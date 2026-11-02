import WebSocket from "ws";
import path from "node:path";
import { monitorTwitchAuth } from "./twitch-lifecycle.js";
import { TwitchAPI, EVENTSUB_TYPES } from "./twitch-api.js";

export function twitchSubscriptions(env = {}) {
  return ["channel.chat.message", "channel.raid", "channel.follow", "stream.online", "stream.offline",
    ...(env.TWITCH_POLLS === "true" ? ["channel.poll.end"] : []),
    ...(env.TWITCH_SUBSCRIPTIONS === "true" ? ["channel.subscribe"] : []),
    ...(env.PAYMENTS_LIVE === "true" && env.TWITCH_REWARD_ID
      ? ["channel.channel_points_custom_reward_redemption.add"] : []),
  ];
}

/** EventSub is the authority for chat badges. Never accept badges supplied by a client. */
export function connectTwitch(onEvent, env = process.env, {
  api = new TwitchAPI(env, { envFile: path.resolve(import.meta.dirname, "../.env") }),
  socketURL = env.TWITCH_EVENTSUB_WS_URL || "wss://eventsub.wss.twitch.tv/ws",
  subscriptionTypes = twitchSubscriptions(env),
  onStatus = () => {}, socketFactory = url => new WebSocket(url), logger = console,
  retryMs = 3000,
} = {}) {
  const types = [...new Set(subscriptionTypes)].filter(type => EVENTSUB_TYPES[type]);
  const status = { connection: "disabled", subscriptions: Object.fromEntries(types.map(type =>
    [EVENTSUB_TYPES[type].key, { status: "disabled" }])) };
  const publish = () => onStatus(structuredClone(status));
  const missing = ["TWITCH_CLIENT_ID", "TWITCH_TOKEN", "TWITCH_BROADCASTER_ID", "TWITCH_USER_ID"]
    .some(key => !env[key]);
  if (missing) return { enabled: false, status, api, close() {} };
  status.connection = "connecting";
  const origin = new URL(socketURL).origin;
  let stopped = false, active = null, retry, stopMonitor;
  const sockets = new Set(), seen = new Set();
  function connect(url = socketURL, handoff = false) {
    if (stopped) return;
    const socket = socketFactory(url);
    sockets.add(socket);
    let keepaliveMs = 15000;
    let watchdog = setTimeout(() => socket.terminate(), keepaliveMs);
    watchdog.unref?.();
    socket.on("message", async raw => {
      try {
        const message = JSON.parse(raw);
        clearTimeout(watchdog);
        if (message.payload?.session?.keepalive_timeout_seconds)
          keepaliveMs = (message.payload.session.keepalive_timeout_seconds + 5) * 1000;
        watchdog = setTimeout(() => socket.terminate(), keepaliveMs);
        watchdog.unref?.();
        const type = message.metadata?.message_type;
        if (type === "session_welcome") {
          const old = active;
          active = socket;
          if (!handoff) await Promise.all(types.map(async type => {
            const key = EVENTSUB_TYPES[type].key;
            status.subscriptions[key] = { status: "subscribing" };
            publish();
            try {
              await api.subscribe(type, message.payload.session.id);
              status.subscriptions[key] = { status: "enabled" };
            } catch {
              status.subscriptions[key] = { status: "failed", error: "Subscription request failed" };
              logger.error(`Twitch ${key} subscription failed`);
            }
            publish();
          }));
          if (stopped) return;
          if (old && old !== socket) old.close();
          status.connection = "connected";
          publish();
        } else if (type === "session_reconnect") {
          const next = new URL(message.payload.session.reconnect_url);
          if (next.origin !== origin || next.username || next.password)
            throw Error("Unexpected Twitch reconnect host");
          connect(next.href, true);
        } else if (type === "revocation") {
          const subscription = message.payload.subscription;
          if (types.includes(subscription.type)) {
            status.subscriptions[EVENTSUB_TYPES[subscription.type].key] = {
              status: "revoked", reason: ["authorization_revoked", "user_removed", "version_removed"]
                .includes(subscription.status) ? subscription.status : "revoked",
            };
            publish();
          }
        } else if (type === "notification") {
          const subscription = message.payload?.subscription;
          const event = message.payload?.event;
          const id = message.metadata.message_id;
          if (!types.includes(subscription?.type) || !event || typeof id !== "string" || !id || seen.has(id)) return;
          // Fence shared-chat events from other channels and any wrongly routed payload.
          const channel = subscription.type === "channel.raid" ? event.to_broadcaster_user_id : event.broadcaster_user_id;
          if (channel !== env.TWITCH_BROADCASTER_ID) return;
          if (subscription.type === "channel.chat.message" && event.source_broadcaster_user_id &&
              event.source_broadcaster_user_id !== env.TWITCH_BROADCASTER_ID) return;
          if (subscription.type === "channel.channel_points_custom_reward_redemption.add" &&
              (env.PAYMENTS_LIVE !== "true" || event.reward?.id !== env.TWITCH_REWARD_ID)) return;
          seen.add(id);
          if (seen.size > 5000) seen.delete(seen.values().next().value);
          await onEvent({ type: subscription.type, id, event });
        }
      } catch {
        logger.error("Twitch event processing failed");
        socket.close();
      }
    });
    socket.on("error", () => logger.error("Twitch socket connection failed"));
    socket.on("close", () => {
      clearTimeout(watchdog);
      sockets.delete(socket);
      if (!stopped && status.connection !== "reauthorization-required" && (active === socket || !active)) {
        status.connection = "reconnecting";
        publish();
        active = null;
        clearTimeout(retry);
        retry = setTimeout(() => connect(), retryMs);
        retry.unref?.();
      }
    });
  }
  const unsubscribeAuth = api.onAuthChange?.(auth => {
    status.auth = auth;
    if (auth.status === "reauthorization-required") {
      status.connection = "reauthorization-required";
      clearTimeout(retry);
      for (const socket of sockets) socket.close();
    }
    publish();
  });
  void api.validateToken("startup").then(() => {
    if (stopped) return;
    connect();
    stopMonitor = monitorTwitchAuth(api, {
      onFailure: () => logger.error("Twitch authorization check failed"),
    });
  }).catch(() => {
    if (stopped) return;
    status.connection = api.authState?.().status === "reauthorization-required"
      ? "reauthorization-required" : "authentication-failed";
    publish();
    logger.error("Twitch authentication failed");
  });
  return { enabled: true, status, api, close() {
    stopped = true;
    clearTimeout(retry);
    stopMonitor?.();
    unsubscribeAuth?.();
    for (const socket of sockets) socket.close();
    status.connection = "closed";
    publish();
  } };
}
