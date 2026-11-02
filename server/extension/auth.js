import { createHmac, timingSafeEqual } from "node:crypto";

export class ExtensionError extends Error {
  constructor(status, code) {
    super(code);
    Object.assign(this, { status, code });
  }
}
export function decodeSecret(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new ExtensionError(503, "extension_not_configured");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length < 32 ||
    bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
  )
    throw new ExtensionError(503, "extension_not_configured");
  return bytes;
}
export function signExtensionJWT(payload, secret) {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = header + "." + body;
  return (
    signed +
    "." +
    createHmac("sha256", secret).update(signed).digest("base64url")
  );
}
export function verifyExtensionJWT(token, secret, channelId, now = Date.now()) {
  const reject = () => {
    throw new ExtensionError(401, "invalid_authorization");
  };
  if (typeof token !== "string" || token.length > 4096) reject();
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
  )
    reject();
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url"));
  } catch {
    reject();
  }
  if (
    !header ||
    header.alg !== "HS256" ||
    (header.typ !== undefined && header.typ !== "JWT") ||
    header.crit ||
    !claims
  )
    reject();
  const expected = createHmac("sha256", secret)
    .update(parts[0] + "." + parts[1])
    .digest();
  const supplied = Buffer.from(parts[2], "base64url");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(expected, supplied)
  )
    reject();
  if (
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= now / 1000 ||
    (claims.nbf !== undefined &&
      (!Number.isFinite(claims.nbf) || claims.nbf > now / 1000)) ||
    claims.channel_id !== channelId ||
    !["viewer", "broadcaster", "moderator"].includes(claims.role) ||
    typeof claims.opaque_user_id !== "string" ||
    !/^[UA][A-Za-z0-9_-]{1,79}$/.test(claims.opaque_user_id) ||
    (claims.user_id !== undefined &&
      (typeof claims.user_id !== "string" ||
        !/^[0-9]{1,30}$/.test(claims.user_id)))
  )
    reject();
  return {
    opaqueId: claims.opaque_user_id,
    role: claims.role,
    userId: typeof claims.user_id === "string" ? claims.user_id : null,
  };
}
