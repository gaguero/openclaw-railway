/**
 * Simple in-memory rate limit for NaBoTo ingest (per client IP).
 * OK for single Railway replica; use Redis if you scale horizontally.
 */
const WINDOW_MS = 60_000;
const MAX_REQUESTS = parseInt(process.env.NABOTO_INGEST_RATE_MAX || '120', 10);

const buckets = new Map();

function clientKey(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) {
    return xf.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * @returns {429|null} Response body object if limited, else null to continue
 */
export function nabotoIngestRateLimit(req) {
  const key = clientKey(req);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > MAX_REQUESTS) {
    return {
      status: 429,
      body: {
        error: 'Too many requests',
        retry_after_seconds: Math.ceil((b.resetAt - now) / 1000),
      },
    };
  }
  return null;
}
