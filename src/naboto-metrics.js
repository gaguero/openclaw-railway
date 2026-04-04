/**
 * NaBoTo metrics JSON (Bearer NABOTO_INGEST_SECRET).
 */
import { getNabotoPool, nabotoBearerOk } from './naboto-pool.js';

export async function nabotoMetricsHandler(req, res) {
  if (!process.env.NABOTO_INGEST_SECRET) {
    return res.status(503).json({ error: 'NABOTO_INGEST_SECRET not set' });
  }
  if (!nabotoBearerOk(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ error: 'DATABASE_URL not configured' });
  }

  try {
    const q = async (sql, params = []) => {
      const r = await p.query(sql, params);
      return Number(r.rows[0]?.c ?? 0);
    };

    const observations_24h = await q(
      `SELECT count(*)::int AS c FROM bot_observations WHERE created_at > NOW() - INTERVAL '24 hours'`,
    );
    const observations_7d = await q(
      `SELECT count(*)::int AS c FROM bot_observations WHERE created_at > NOW() - INTERVAL '7 days'`,
    );
    let pending_actions = 0;
    try {
      pending_actions = await q(
        `SELECT count(*)::int AS c FROM naboto_pending_actions WHERE status = 'pending'`,
      );
    } catch {
      pending_actions = -1;
    }
    let dream_runs_7d = 0;
    try {
      dream_runs_7d = await q(
        `SELECT count(*)::int AS c FROM naboto_dream_runs WHERE started_at > NOW() - INTERVAL '7 days'`,
      );
    } catch {
      dream_runs_7d = -1;
    }

    return res.json({
      observations_24h,
      observations_7d,
      pending_actions,
      dream_runs_7d,
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[naboto-metrics]', e.message);
    return res.status(500).json({ error: 'Metrics failed' });
  }
}
