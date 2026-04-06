/**
 * Shared Postgres pool for NaBoTo routes (single pool per process).
 */
import pg from 'pg';

const { Pool } = pg;

let pool = null;

/**
 * Railway public Postgres proxies (`*.proxy.rlwy.net`) need TLS; internal URLs often omit sslmode.
 * @param {string} connectionString
 * @returns {object | undefined} pg `ssl` option
 */
function nabotoPoolSslOption(connectionString) {
  const s = String(connectionString || '');
  if (/sslmode=disable/i.test(s)) return undefined;
  if (/sslmode=require|sslmode=verify-full|ssl=true/i.test(s)) {
    return { rejectUnauthorized: false };
  }
  try {
    const normalized = s.replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:');
    const u = new URL(normalized);
    const host = (u.hostname || '').toLowerCase();
    if (host.endsWith('proxy.rlwy.net') || host.endsWith('railway.app')) {
      return { rejectUnauthorized: false };
    }
  } catch {
    // ignore malformed URL
  }
  return undefined;
}

export function getNabotoPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return null;
  }
  if (!pool) {
    const ssl = nabotoPoolSslOption(url);
    pool = new Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: 8000,
      ...(ssl ? { ssl } : {}),
    });
  }
  return pool;
}

export function nabotoBearerOk(req, secretEnv = 'NABOTO_INGEST_SECRET') {
  const secret = process.env[secretEnv];
  if (!secret) {
    return false;
  }
  const authHeader = req.headers.authorization || '';
  const [type, token] = authHeader.split(/\s+/);
  return type === 'Bearer' && token === secret;
}
