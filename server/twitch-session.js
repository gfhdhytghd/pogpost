import { TwitchAuthLog } from "./twitch-auth-log.js";
import { TwitchCredentials, TwitchAuthError } from "./twitch-credentials.js";

export class TwitchSession {
  constructor(
    env,
    {
      fetcher = fetch,
      base = env.TWITCH_API_BASE || "https://api.twitch.tv/helix",
      authBase = env.TWITCH_AUTH_BASE || "https://id.twitch.tv/oauth2",
      persist = async () => {},
      envFile = null,
      journal = new TwitchAuthLog(),
      now = Date.now,
    } = {},
  ) {
    Object.assign(this, { env, fetcher, persist, journal, now });
    this.base = base.replace(/\/+$/, "");
    this.authBase = authBase.replace(/\/+$/, "");
    this.credentials = envFile
      ? new TwitchCredentials(envFile, { journal, now })
      : null;
    this.listeners = new Set();
    this.auth = {
      status: "unverified",
      expiresAt: null,
      refreshAt: null,
      reason: null,
    };
    this.refreshing = null;
    this.validating = null;
  }
  authState() {
    return { ...this.auth };
  }
  onAuthChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(status, reason = null, expiresIn) {
    if (Number.isFinite(expiresIn)) {
      this.auth.expiresAt = this.now() + expiresIn * 1000;
      this.auth.refreshAt =
        this.auth.expiresAt - Math.min(600000, expiresIn * 200);
    } else if (
      Number.isFinite(Number(this.env.TWITCH_EXPIRES_AT)) &&
      this.env.TWITCH_EXPIRES_AT
    ) {
      this.auth.expiresAt = Number(this.env.TWITCH_EXPIRES_AT);
      const remaining = Math.max(0, this.auth.expiresAt - this.now());
      this.auth.refreshAt =
        this.auth.expiresAt - Math.min(600000, remaining * 0.2);
    }
    Object.assign(this.auth, { status, reason });
    for (const listener of this.listeners) listener(this.authState());
  }
  async prepare() {
    const previous = this.env.TWITCH_TOKEN;
    if (this.credentials) await this.credentials.load(this.env);
    if (this.env.TWITCH_TOKEN !== previous) this.publish("ready");
    if (this.auth.status === "reauthorization-required")
      throw new TwitchAuthError(this.auth.reason);
  }
  async exchange(trigger, attempt) {
    const previous = { ...this.env };
    await this.journal.write("refresh", this.env, {
      trigger,
      phase: "request",
      attempt,
    });
    const response = await this.fetcher(this.authBase + "/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: previous.TWITCH_REFRESH_TOKEN,
        client_id: previous.TWITCH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(8000),
    });
    let data = {};
    if (response.ok) {
      try {
        data = await response.json();
      } catch {
        await this.journal.write("refresh", previous, {
          trigger,
          attempt,
          phase: "response",
          http_status: response.status,
          reason: "invalid-refresh-response",
        });
        throw new TwitchAuthError("invalid-refresh-response", response.status);
      }
    }
    const next = {
      ...this.env,
      TWITCH_TOKEN: data.access_token,
      TWITCH_REFRESH_TOKEN: data.refresh_token,
    };
    await this.journal.write("refresh", response.ok ? next : this.env, {
      trigger,
      phase: "response",
      attempt,
      http_status: response.status,
      expires_in: data.expires_in,
      refresh_returned:
        typeof data.refresh_token === "string" && !!data.refresh_token,
      refresh_rotated:
        !!data.refresh_token &&
        data.refresh_token !== previous.TWITCH_REFRESH_TOKEN,
      previous,
    });
    if (!response.ok)
      throw new TwitchAuthError("refresh-rejected", response.status);
    if (typeof data.access_token !== "string" || !data.access_token)
      throw new TwitchAuthError("invalid-refresh-response", response.status);
    return data;
  }
  refresh(trigger = "manual", expectedAccess = this.env.TWITCH_TOKEN) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        let result;
        if (this.credentials)
          result = await this.credentials.refresh(
            this.env,
            expectedAccess,
            trigger,
            (attempt) => this.exchange(trigger, attempt),
          );
        else if (this.env.TWITCH_TOKEN !== expectedAccess)
          result = { reused: true };
        else {
          if (!this.env.TWITCH_REFRESH_TOKEN)
            throw new TwitchAuthError("missing-refresh-token");
          const data = await this.exchange(trigger);
          const values = {
            TWITCH_TOKEN: data.access_token,
            TWITCH_REFRESH_TOKEN: data.refresh_token || "",
          };
          await this.persist(values);
          Object.assign(this.env, values);
          await this.journal.write("persist", this.env, {
            trigger,
            phase: "committed",
            expires_in: data.expires_in,
            refresh_returned: !!data.refresh_token,
          });
          result = { expires_in: data.expires_in };
        }
        if (!this.env.TWITCH_REFRESH_TOKEN)
          throw new TwitchAuthError("missing-rotated-refresh-token");
        this.publish("ready", null, result.expires_in);
        return result;
      } catch (error) {
        const failure =
          error instanceof TwitchAuthError
            ? error
            : new TwitchAuthError("refresh-outcome-uncertain");
        this.publish("reauthorization-required", failure.reason);
        await this.journal.write("failure", this.env, {
          trigger,
          http_status: failure.httpStatus,
          reason: failure.reason,
        });
        throw failure;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  validateToken(trigger = "startup") {
    if (this.validating) return this.validating;
    this.validating = (async () => {
      try {
        await this.prepare();
        const check = async (cause) => {
          const snapshot = { ...this.env };
          const token = snapshot.TWITCH_TOKEN;
          await this.journal.write("validate", snapshot, {
            trigger: cause,
            phase: "request",
          });
          const response = await this.fetcher(this.authBase + "/validate", {
            headers: { Authorization: `OAuth ${token}` },
            signal: AbortSignal.timeout(8000),
          });
          let info = {};
          if (response.ok) {
            try {
              info = await response.json();
            } catch {
              await this.journal.write("validate", snapshot, {
                trigger: cause,
                phase: "response",
                http_status: response.status,
                reason: "validation-unavailable",
              });
              const error = Error("Twitch validation unavailable");
              error.httpStatus = response.status;
              throw error;
            }
          }
          await this.journal.write("validate", snapshot, {
            trigger: cause,
            phase: "response",
            http_status: response.status,
            expires_in: info.expires_in,
          });
          return { response, info, token, snapshot };
        };
        let checked = await check(trigger);
        if (checked.response.status === 401) {
          await this.refresh("401", checked.token);
          checked = await check("401");
        }
        const { response, info } = checked;
        if (!response.ok) {
          if (response.status === 401)
            throw new TwitchAuthError("validation-rejected", 401);
          throw Error("Twitch validation unavailable");
        }
        if (
          info.client_id !== checked.snapshot.TWITCH_CLIENT_ID ||
          info.user_id !== checked.snapshot.TWITCH_USER_ID
        )
          throw new TwitchAuthError("identity-mismatch", response.status);
        this.publish("ready", null, info.expires_in);
        return info;
      } catch (error) {
        const required = error instanceof TwitchAuthError;
        this.publish(
          required ? "reauthorization-required" : "degraded",
          required ? error.reason : "validation-unavailable",
        );
        await this.journal.write("failure", this.env, {
          trigger,
          http_status: error.httpStatus,
          reason: required ? error.reason : "validation-unavailable",
        });
        throw required ? error : Error("Twitch validation unavailable");
      }
    })().finally(() => {
      this.validating = null;
    });
    return this.validating;
  }
}

/** A Device Code pair is validated before its identity or credentials are published. */
export async function inspectAuthorization(api, token, journal, clientId) {
  const env = {
    TWITCH_TOKEN: token.access_token,
    TWITCH_REFRESH_TOKEN: token.refresh_token,
  };
  let response;
  try {
    await journal.write("validate", env, {
      trigger: "device",
      phase: "request",
    });
    response = await api.fetcher(api.authBase + "/validate", {
      headers: { Authorization: `OAuth ${token.access_token}` },
      signal: AbortSignal.timeout(8000),
    });
    // Record the status even when a successful response has malformed JSON.
    await journal.write("validate", env, {
      trigger: "device",
      phase: "response",
      http_status: response.status,
    });
    const identity = response.ok ? await response.json() : {};
    if (
      !response.ok ||
      identity.client_id !== clientId ||
      typeof identity.user_id !== "string"
    )
      throw new TwitchAuthError("device-identity-rejected", response.status);
    await journal.write("validate", env, {
      trigger: "device",
      phase: "complete",
      http_status: response.status,
      expires_in: identity.expires_in,
    });
    return identity;
  } catch {
    await journal.write("failure", env, {
      trigger: "device",
      http_status: response?.status,
      reason: "device-identity-rejected",
    });
    throw new TwitchAuthError("device-identity-rejected", response?.status);
  }
}
