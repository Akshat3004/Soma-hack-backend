/**
 * Adaptive concurrency limiter (AIMD) + per-endpoint circuit breakers.
 *
 * The PCC client routes every request through `limiter.schedule(fn)`. The
 * limiter finds the API's real throughput ceiling automatically:
 *   - success  → additive increase  (limit += STEP_UP)
 *   - throttle → multiplicative decrease (limit /= 2)
 * This is the TCP-congestion trick applied to a hostile API: ramp up while
 * it's happy, back off hard the instant it pushes back.
 */
export class AdaptiveLimiter {
  constructor({ min = 1, max = 16, start = 4, stepUp = 0.5 } = {}) {
    this.min = min;
    this.max = max;
    this.limit = start;
    this.stepUp = stepUp;
    this.active = 0;
    this.queue = [];
  }

  get concurrency() {
    return Math.max(1, Math.floor(this.limit));
  }

  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          this.active--;
          this._drain();
        });
    }
  }

  onSuccess() {
    this.limit = Math.min(this.max, this.limit + this.stepUp);
  }

  onThrottle() {
    this.limit = Math.max(this.min, this.limit / 2);
  }
}

/**
 * Per-endpoint circuit breaker. Trips OPEN after `threshold` consecutive HARD
 * failures (5xx / network) — NOT on 429s, which are expected throttling. While
 * open it fails fast for `cooldownMs`, then half-opens to probe recovery.
 */
export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 10_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.state = 'closed'; // closed | open | half-open
    this.openedAt = 0;
  }

  canRequest() {
    if (this.state !== 'open') return true;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
      return true;
    }
    return false;
  }

  cooldownRemaining() {
    return Math.max(0, this.cooldownMs - (Date.now() - this.openedAt));
  }

  onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  onFailure() {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}

/** Lazily-created breaker per endpoint path. */
class BreakerRegistry {
  constructor(opts) {
    this.opts = opts;
    this.map = new Map();
  }

  get(endpoint) {
    let b = this.map.get(endpoint);
    if (!b) {
      b = new CircuitBreaker(this.opts);
      this.map.set(endpoint, b);
    }
    return b;
  }
}

// Shared singletons used by the PCC client.
export const limiter = new AdaptiveLimiter();
export const breakers = new BreakerRegistry();
