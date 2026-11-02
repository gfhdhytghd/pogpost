/** Public relay traffic uses explicit routes; operator access requires direct loopback. */
export function isLocalRequest(request) {
  const address = request.socket?.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) return false;
  if (
    [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
    ].some((key) => request.headers[key])
  )
    return false;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(
      new URL("http://" + request.headers.host).hostname,
    );
  } catch {
    return false;
  }
}
