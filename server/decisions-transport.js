import https from "node:https";

/** One TLS connection shared by requests. Client admission bounds the Agent's waiting queue. */
export class DecisionsTransport {
  #agent;
  #request;
  #active = new Set();
  #closed = false;
  constructor({ requestFn = https.request, agent } = {}) {
    this.#request = requestFn;
    this.#agent = agent || new https.Agent({
      keepAlive: true,
      maxSockets: 1,
      maxTotalSockets: 1,
      maxFreeSockets: 1,
      scheduling: "lifo",
    });
  }
  fetch(url, { method, headers, body, signal }) {
    return new Promise((resolve, reject) => {
      if (this.#closed) return reject(Error("Transport closed"));
      const started = performance.now();
      let connectMs = null;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        this.#active.delete(request);
        if (error) reject(Error("Decisions transport failed"));
        else resolve(value);
      };
      const request = this.#request(url, {
        method,
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        agent: this.#agent,
        signal,
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) {
            request.destroy();
            finish(true);
          } else chunks.push(chunk);
        });
        response.on("error", () => finish(true));
        response.on("end", () => {
          if (settled) return;
          // Error bodies are neither parsed nor propagated into diagnostics.
          if (response.statusCode < 200 || response.statusCode >= 300)
            return finish(null, { ok: false });
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            finish(null, {
              ok: true,
              json: async () => value,
              connection: { reused: request.reusedSocket === true, connect_ms: connectMs },
            });
          } catch {
            finish(true);
          }
        });
      });
      this.#active.add(request);
      request.on("socket", (socket) => {
        if (request.reusedSocket) connectMs = 0;
        else socket.once("secureConnect", () => {
          connectMs = Math.round((performance.now() - started) * 10) / 10;
        });
      });
      request.on("error", () => finish(true));
      request.end(body);
    });
  }
  close() {
    this.#closed = true;
    for (const request of this.#active) request.destroy();
    this.#active.clear();
    this.#agent.destroy();
  }
}
