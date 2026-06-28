import { config } from '../config/env.js';
import { metrics } from './metrics.js';
import { limiter, breakers } from './adaptiveLimiter.js';

const BASE = config.pccBaseUrl;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff with jitter, capped at 8s (used for 5xx / network).
const backoff = (attempt) => Math.min(8000, 250 * 2 ** attempt) + Math.random() * 250;

function buildUrl(path, params) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * Low-level request: returns a full envelope so callers can land the raw
 * response. All resilience lives here:
 *   - adaptive concurrency (AIMD) via the shared limiter
 *   - per-endpoint circuit breaker
 *   - 429 → honor Retry-After + AIMD decrease (NOT a breaker failure)
 *   - 5xx / network → backoff + AIMD decrease + breaker failure
 *   - other 4xx → throw immediately (retrying won't help)
 *
 * @returns {Promise<{status,json,rawText,endpoint,params,attempts,durationMs}>}
 */
export function pccRequest(path, params = {}, { maxRetries = 10 } = {}) {
  return limiter.schedule(() => attempt(path, params, maxRetries));
}

async function attempt(path, params, maxRetries) {
  const url = buildUrl(path, params);
  const breaker = breakers.get(path);
  const startedAt = Date.now();
  let tries = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!breaker.canRequest()) {
      // Breaker is open — wait out the cooldown rather than hammering.
      await sleep(Math.min(breaker.cooldownRemaining() + 50, 5000));
      continue;
    }

    tries++;
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (err) {
      metrics.record(path, { error: true });
      limiter.onThrottle();
      breaker.onFailure();
      if (tries > maxRetries) throw new Error(`Network error for ${url}: ${err.message}`);
      await sleep(backoff(tries));
      continue;
    }

    if (res.status === 429) {
      metrics.record(path, { throttled: true });
      limiter.onThrottle(); // expected throttle — adapt, but don't trip breaker
      if (tries > maxRetries) throw new Error(`429 retries exhausted for ${url}`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(tries));
      continue;
    }

    if (res.status >= 500) {
      metrics.record(path, { error: true });
      limiter.onThrottle();
      breaker.onFailure();
      if (tries > maxRetries) throw new Error(`${res.status} retries exhausted for ${url}`);
      await sleep(backoff(tries));
      continue;
    }

    const rawText = await res.text().catch(() => '');

    if (!res.ok) {
      // Hard 4xx (e.g. 422) — a bad request; retrying is pointless.
      metrics.record(path, { error: true });
      breaker.onFailure();
      throw new Error(`${res.status} ${res.statusText} for ${url} — ${rawText.slice(0, 200)}`);
    }

    // Success.
    limiter.onSuccess();
    breaker.onSuccess();
    const durationMs = Date.now() - startedAt;
    metrics.record(path, { ok: true, durationMs });

    let json = null;
    if (rawText) {
      try {
        json = JSON.parse(rawText);
      } catch {
        // Spite-API returned 200 with non-JSON. Surface as a hard error so the
        // raw text is still captured upstream rather than silently dropped.
        throw new Error(`Invalid JSON (200) from ${url}: ${rawText.slice(0, 120)}`);
      }
    }

    return { status: res.status, json, rawText, endpoint: path, params, attempts: tries, durationMs };
  }
}

/** Convenience wrapper that returns just the parsed JSON body. */
export async function pccGet(path, params, opts) {
  return (await pccRequest(path, params, opts)).json;
}
