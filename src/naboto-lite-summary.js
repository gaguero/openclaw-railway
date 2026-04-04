/**
 * Lite panel: recent observations + 24h count (cookie auth via authMiddleware).
 */
import { getNabotoPool } from './naboto-pool.js';

export async function nabotoLiteSummaryHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.json({ ok: false, reason: 'no DATABASE_URL' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  try {
    const recent = await p.query(
      `SELECT id, source_group, left(message_text, 200) AS message_preview,
              message_author, created_at
       FROM bot_observations
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    const c24 = await p.query(
      `SELECT count(*)::int AS c FROM bot_observations
       WHERE created_at > NOW() - INTERVAL '24 hours'`,
    );
    let pending = null;
    try {
      const cp = await p.query(
        `SELECT count(*)::int AS c FROM naboto_pending_actions WHERE status = 'pending'`,
      );
      pending = cp.rows[0].c;
    } catch {
      pending = null;
    }
    return res.json({
      ok: true,
      recent: recent.rows,
      observations_24h: c24.rows[0].c,
      pending_actions: pending,
    });
  } catch (e) {
    console.error('[naboto-lite-summary]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
