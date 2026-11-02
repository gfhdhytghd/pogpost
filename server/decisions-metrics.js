const percentile = (sorted, fraction) =>
  sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;

/** Last 100 completed chat classifications; warm-ups and superseded queued messages are separate. */
export class DecisionsMetrics {
  constructor() {
    this.rows = [];
    this.coalesced = 0;
  }
  add(row) {
    this.rows.push({ phase: row.phase, latency_ms: row.latency_ms, fallback: row.source === "rules" });
    if (this.rows.length > 100) this.rows.shift();
  }
  summary(phase) {
    const rows = this.rows.filter((row) => !phase || row.phase === phase);
    const latencies = rows.map((row) => row.latency_ms).sort((a, b) => a - b);
    const fallbacks = rows.filter((row) => row.fallback).length;
    return {
      samples: rows.length,
      p50_ms: percentile(latencies, 0.5),
      p95_ms: percentile(latencies, 0.95),
      fallbacks,
      fallback_rate: rows.length ? fallbacks / rows.length : null,
    };
  }
  state() {
    return { window: 100, ...this.summary(), replay: this.summary("replay"),
      play: this.summary("play"), coalesced: this.coalesced };
  }
}
