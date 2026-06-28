import { config } from '../config/env.js';

const BASE = config.pccBaseUrl;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Exponential backoff with jitter, capped at 8s.
const backoff = (attempt) => Math.min(8000, 250 * 2 ** attempt) + Math.random() * 250;

/**
 * GET a PCC endpoint with resilient retry handling.
 *
 * Retries on:
 *   - 429 Too Many Requests  → waits `Retry-After` seconds (the API sends 1–5)
 *   - 5xx server errors       → exponential backoff
 *   - network/transport errors → exponential backoff
 *
 * @param {string} path   e.g. '/pcc/patients'
 * @param {object} params query params (null/undefined values are skipped)
 * @param {{maxRetries?: number}} [opts]
 * @returns {Promise<any>} parsed JSON body
 */
export async function pccGet(path, params = {}, { maxRetries = 10 } = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (err) {
      if (attempt++ >= maxRetries) throw new Error(`Network error for ${url}: ${err.message}`);
      await sleep(backoff(attempt));
      continue;
    }

    if (res.status === 429) {
      if (attempt++ >= maxRetries) throw new Error(`429 retries exhausted for ${url}`);
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      continue;
    }

    if (res.status >= 500) {
      if (attempt++ >= maxRetries) throw new Error(`${res.status} retries exhausted for ${url}`);
      await sleep(backoff(attempt));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText} for ${url} — ${body.slice(0, 200)}`);
    }

    return res.json();
  }
}
