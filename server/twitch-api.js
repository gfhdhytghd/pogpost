import { TwitchAuthLog } from "./twitch-auth-log.js";
import { TwitchAuthError } from "./twitch-credentials.js";
import { TwitchSession } from "./twitch-session.js";
export { saveEnv } from "./env-store.js";
export { inspectAuthorization } from "./twitch-session.js";

// Base scopes work on a regular channel. Affiliate-only features require explicit opt-in.
export const SCOPES = ["user:read:chat", "moderator:read:followers"];
export function requiredScopes(env = {}) {
  return [...SCOPES,
    ...(env.TWITCH_POLLS === "true" ? ["channel:read:polls"] : []),
    ...(env.TWITCH_SUBSCRIPTIONS === "true" ? ["channel:read:subscriptions"] : []),
    ...(env.PAYMENTS_LIVE === "true" ? ["channel:read:redemptions", "channel:manage:redemptions"] : []),
  ];
}
// https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/
export const EVENTSUB_TYPES = Object.freeze({
  "channel.chat.message": { version: "1", key: "chat" },
  "channel.raid": { version: "1", key: "raid" },
  "channel.follow": { version: "2", key: "follow" },
  "channel.poll.end": { version: "1", key: "poll" },
  "channel.subscribe": { version: "1", key: "subscription" },
  "channel.channel_points_custom_reward_redemption.add": { version: "1", key: "redemptions" },
  "stream.online": { version: "1", key: "online" },
  "stream.offline": { version: "1", key: "offline" },
});
export class TwitchAPI extends TwitchSession {
  async request(endpoint, { method = "GET", body } = {}, retry = true) {
    let response, sent;
    try {
      await this.prepare();
      sent = { ...this.env };
      const token = sent.TWITCH_TOKEN;
      response = await this.fetcher(this.base + endpoint, {
        method,
        headers: {
          "Client-Id": sent.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 401 && retry) {
        await this.journal.write("failure", sent, {
          trigger: "401",
          http_status: 401,
          reason: "api-rejected",
        });
        await this.refresh("401", token);
        return this.request(endpoint, { method, body }, false);
      }
      if (!response.ok) {
        if (response.status === 401)
          throw new TwitchAuthError("validation-rejected", 401);
        throw Error("Twitch API request failed");
      }
      return await response.json();
    } catch (error) {
      await this.journal.write("failure", sent || this.env, {
        trigger: response?.status === 401 ? "401" : "manual",
        http_status: response?.status || error.httpStatus,
        reason: "api-unavailable",
      });
      if (error instanceof TwitchAuthError)
        this.publish("reauthorization-required", error.reason);
      throw error instanceof TwitchAuthError
        ? error
        : Error("Twitch API unavailable");
    }
  }
  subscribe(type, sessionId) {
    const spec = EVENTSUB_TYPES[type];
    if (!spec) throw Error("Unsupported Twitch subscription");
    const channel = this.env.TWITCH_BROADCASTER_ID;
    const condition = type === "channel.raid"
      ? { to_broadcaster_user_id: channel }
      : { broadcaster_user_id: channel };
    if (type === "channel.chat.message") condition.user_id = this.env.TWITCH_USER_ID;
    if (type === "channel.follow") condition.moderator_user_id = this.env.TWITCH_USER_ID;
    if (type === "channel.channel_points_custom_reward_redemption.add") {
      if (this.env.PAYMENTS_LIVE !== "true" || !this.env.TWITCH_REWARD_ID)
        throw Error("Live reward subscriptions are disabled");
      condition.reward_id = this.env.TWITCH_REWARD_ID;
    }
    return this.request("/eventsub/subscriptions", {
      method: "POST",
      body: { type, version: spec.version, condition,
        transport: { method: "websocket", session_id: sessionId } },
    });
  }
  async sendChat(message) {
    const response = await this.request("/chat/messages", {
      method: "POST",
      body: {
        broadcaster_id: this.env.TWITCH_BROADCASTER_ID,
        sender_id: this.env.TWITCH_USER_ID,
        message,
      },
    });
    if (!response.data?.[0]?.is_sent)
      throw Error("Twitch chat message was not sent");
    return response;
  }
  async identity() {
    const info = await this.validateToken();
    const response = await this.request(
      "/users?id=" + encodeURIComponent(info.user_id),
    );
    return {
      ...info,
      login: response.data?.[0]?.login || info.login,
      eligible: ["affiliate", "partner"].includes(
        response.data?.[0]?.broadcaster_type,
      ),
    };
  }
  async ensureReward(cost) {
    if (this.env.PAYMENTS_LIVE !== "true") throw Error("Live payments are disabled");
    if (!Number.isSafeInteger(cost) || cost < 1) throw Error("Invalid reward cost");
    const endpoint = "/channel_points/custom_rewards?broadcaster_id=" +
      encodeURIComponent(this.env.TWITCH_BROADCASTER_ID);
    const response = await this.request(endpoint + "&only_manageable_rewards=true");
    const existing = response.data?.find(item => item.title === "Seal a note");
    const result = await this.request(existing ? endpoint + "&id=" + encodeURIComponent(existing.id) : endpoint, {
      method: existing ? "PATCH" : "POST",
      // The body lives only in the extension. Twitch must never ask for private note input.
      body: { title: "Seal a note", cost, is_user_input_required: false },
    });
    const reward = result.data?.[0];
    if (!reward?.id) throw Error("Twitch did not return a reward");
    return { id: reward.id, title: reward.title, cost: reward.cost, created: !existing };
  }
  async updateRedemption(id, status, rewardId = this.env.TWITCH_REWARD_ID) {
    if (this.env.PAYMENTS_LIVE !== "true") throw Error("Live payments are disabled");
    if (!["FULFILLED", "CANCELED"].includes(status) || !id || !rewardId)
      throw Error("Invalid redemption update");
    const query = new URLSearchParams({ broadcaster_id: this.env.TWITCH_BROADCASTER_ID,
      reward_id: rewardId, id });
    return this.request("/channel_points/custom_rewards/redemptions?" + query,
      { method: "PATCH", body: { status } });
  }

}

export async function deviceAuthorize(
  clientId,
  {
    fetcher = fetch,
    authBase = "https://id.twitch.tv/oauth2",
    onCode,
    sleep = (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms);
        function done() {
          signal?.removeEventListener("abort", abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          reject(Error("Authorization cancelled"));
        }
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    requiredScopes = SCOPES,
    signal,
    now = Date.now,
    journal = new TwitchAuthLog(),
  } = {},
) {
  let httpStatus;
  try {
    const scopes = requiredScopes.join(" ");
    const first = await fetcher(authBase + "/device", {
      method: "POST",
      body: new URLSearchParams({ client_id: clientId, scopes }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000),
    });
    httpStatus = first.status;
    await journal.write(
      "device",
      {},
      { trigger: "device", phase: "response", http_status: first.status },
    );
    if (!first.ok)
      throw Error("Twitch device authorization HTTP " + first.status);
    const device = await first.json();
    onCode?.({
      verification_uri: device.verification_uri,
      user_code: device.user_code,
      expires_in: device.expires_in,
      interval: device.interval || 5,
    });
    const deadline = now() + device.expires_in * 1000;
    let interval = Math.max(1, device.interval || 5) * 1000;
    while (now() < deadline) {
      await sleep(interval, signal);
      signal?.throwIfAborted();
      const response = await fetcher(authBase + "/token", {
        method: "POST",
        body: new URLSearchParams({
          client_id: clientId,
          scopes,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal: AbortSignal.timeout(8000),
      });
      httpStatus = response.status;
      const token = await response.json();
      await journal.write(
        "device",
        {
          TWITCH_TOKEN: token.access_token,
          TWITCH_REFRESH_TOKEN: token.refresh_token,
        },
        {
          trigger: "device",
          phase: "response",
          http_status: response.status,
          expires_in: token.expires_in,
          refresh_returned: !!token.refresh_token,
        },
      );
      if (response.ok) {
        if (!requiredScopes.every((scope) => token.scope?.includes(scope)))
          throw Error("Authorization missing required scopes");
        return token;
      }
      const reason = token.message || token.error;
      if (reason === "authorization_pending") continue;
      if (reason === "slow_down") {
        interval += 5000;
        continue;
      }
      throw Error(
        reason === "access_denied"
          ? "Twitch authorization denied"
          : "Twitch device authorization failed; request a new code",
      );
    }
    throw Error("Twitch device code expired");
  } catch (error) {
    await journal.write(
      "failure",
      {},
      {
        trigger: "device",
        http_status: httpStatus,
        reason: "device-authorization-failed",
      },
    );
    // JSON/network exceptions can include raw response fragments; expose fixed messages only.
    const messages = new Set([
      "Twitch authorization denied",
      "Twitch device code expired",
      "Authorization cancelled",
      "Authorization missing required scopes",
      "Twitch device authorization failed; request a new code",
    ]);
    throw Error(
      messages.has(error.message)
        ? error.message
        : "Twitch device authorization failed; request a new code",
    );
  }
}
