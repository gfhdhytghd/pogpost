import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { TwitchAPI, deviceAuthorize, inspectAuthorization, requiredScopes } from "./twitch-api.js";
import { TwitchAuthLog } from "./twitch-auth-log.js";
import { TwitchCredentials } from "./twitch-credentials.js";

/** Explicit operator-only authorization. The returned object never contains OAuth credentials. */
export async function authorizeTwitch(env, {
  envFile = path.resolve(import.meta.dirname, "../.env"), fetcher = fetch,
  journal = new TwitchAuthLog(path.join(path.dirname(envFile), "runs/twitch-auth.jsonl")),
  onCode, signal, sleep, now = Date.now, expectedLogin,
  bindExtensionOwner = false, disableLive = false, beforePersist,
} = {}) {
  if (!env.TWITCH_CLIENT_ID) throw Error("Configure the new Twitch client ID first");
  const scopes = requiredScopes(env);
  const token = await deviceAuthorize(env.TWITCH_CLIENT_ID, {
    fetcher, journal, onCode, signal, sleep, now, requiredScopes: scopes,
  });
  const api = new TwitchAPI({ ...env }, { fetcher, journal, now });
  const identity = await inspectAuthorization(api, token, journal, env.TWITCH_CLIENT_ID);
  if (expectedLogin && (typeof identity.login !== "string" || identity.login.toLowerCase() !== expectedLogin.toLowerCase()))
    throw Error("Authorize the expected Twitch account");
  if (!scopes.every(scope => identity.scopes?.includes(scope)))
    throw Error("Authorization missing required scopes");
  // This integration uses the broadcaster's own user token for follower and chat subscriptions.
  if (env.TWITCH_BROADCASTER_ID && env.TWITCH_BROADCASTER_ID !== identity.user_id)
    throw Error("Authorize the configured broadcaster account");
  if (!/^\d{1,30}$/.test(identity.user_id) || !Number.isFinite(identity.expires_in) || identity.expires_in <= 0 || !Array.isArray(identity.scopes))
    throw Error("Twitch authorization validation failed");
  signal?.throwIfAborted();
  const values = { TWITCH_CLIENT_ID: env.TWITCH_CLIENT_ID,
    TWITCH_USER_ID: identity.user_id, TWITCH_BROADCASTER_ID: identity.user_id,
    TWITCH_TOKEN: token.access_token, TWITCH_REFRESH_TOKEN: token.refresh_token,
    TWITCH_SCOPES: identity.scopes.join(" "),
    TWITCH_EXPIRES_AT: String(now() + identity.expires_in * 1000) };
  if (bindExtensionOwner) values.TWITCH_EXT_OWNER_ID = identity.user_id;
  if (disableLive) for (const key of ["PAYMENTS_LIVE", "DECISIONS_LIVE", "TWITCH_CONNECT", "TWITCH_SIGNALS",
    "TWITCH_POLLS", "TWITCH_SUBSCRIPTIONS", "TWITCH_AUTO_SESSION", "OBS_FRAME_WATCHER", "ASTRA_CONDITIONS", "SPEECH_WATCHER"])
    values[key] = "false";
  if (!values.TWITCH_REFRESH_TOKEN) throw Error("Authorization missing refresh token");
  await beforePersist?.();
  signal?.throwIfAborted();
  await new TwitchCredentials(envFile, { journal, now }).install(values, {
    trigger: "device", expiresIn: identity.expires_in,
  });
  Object.assign(env, values);
  return { authorized: true, userId: identity.user_id, scopes: identity.scopes,
    expiresAt: Number(values.TWITCH_EXPIRES_AT) };
}


// Running this command is an explicit operator action; importing this module never authorizes.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const envFile = path.resolve(import.meta.dirname, "../.env");
  try {
    let saved = {};
    try { saved = parseEnv(await readFile(envFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const env = { ...process.env, ...saved };
    console.log("Authorize the broadcaster account for this project's new Twitch app.");
    const result = await authorizeTwitch(env, { envFile,
      onCode: ({ verification_uri, user_code }) => {
        console.log("Open " + verification_uri);
        console.log("Enter the one-time user code: " + user_code);
      },
    });
    console.log("Twitch authorization saved for broadcaster " + result.userId + ".");
  } catch {
    console.error("Twitch authorization failed. Check the new client ID and broadcaster account, then retry.");
    process.exitCode = 1;
  }
}
