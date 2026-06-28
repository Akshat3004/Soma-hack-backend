/**
 * In-memory request metrics for a single sync run. The PCC client updates it
 * on every request; the sync runner resets it at the start of a run and
 * persists a snapshot to `sync_runs` at the end.
 */
class Metrics {
  constructor() {
    this.reset();
  }

  reset() {
    this.requests = 0; // successful 2xx
    this.throttled = 0; // 429s
    this.errors = 0; // 5xx / network / hard 4xx
    this.byEndpoint = {};
    this.startedAt = Date.now();
  }

  _ep(endpoint) {
    return (this.byEndpoint[endpoint] ??= { requests: 0, throttled: 0, errors: 0, totalMs: 0 });
  }

  record(endpoint, { ok = false, throttled = false, error = false, durationMs = 0 } = {}) {
    const ep = this._ep(endpoint);
    if (throttled) {
      this.throttled++;
      ep.throttled++;
    } else if (error) {
      this.errors++;
      ep.errors++;
    } else if (ok) {
      this.requests++;
      ep.requests++;
      ep.totalMs += durationMs;
    }
  }

  snapshot() {
    return {
      requests: this.requests,
      throttled: this.throttled,
      errors: this.errors,
      throttleRate:
        this.requests + this.throttled > 0
          ? +(this.throttled / (this.requests + this.throttled)).toFixed(3)
          : 0,
      byEndpoint: this.byEndpoint,
      elapsedMs: Date.now() - this.startedAt,
    };
  }
}

export const metrics = new Metrics();
