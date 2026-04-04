/**
 * Shared Postgres pool for NaBoTo routes (single pool per process).
 */
import pg from 'pg';

const { Pool } = pg;

let pool = null;

export function getNabotoPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return null;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: 8000,
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
