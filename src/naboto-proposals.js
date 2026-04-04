/**
 * NaBoTo HITL queue — POST proposals, GET list (Bearer NABOTO_INGEST_SECRET).
 */
import { getNabotoPool, nabotoBearerOk } from './naboto-pool.js';

export async function nabotoProposalsPostHandler(req, res) {
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

  const body = req.body || {};
  const actionType = typeof body.action_type === 'string' ? body.action_type.trim() : '';
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : null;
  const requestedBy = typeof body.requested_by === 'string' ? body.requested_by.trim() : null;

  if (!actionType || !payload) {
    return res.status(400).json({ error: 'Invalid body', required: ['action_type', 'payload'] });
  }

  try {
    const r = await p.query(
      `INSERT INTO naboto_pending_actions (action_type, payload, requested_by, status)
       VALUES ($1, $2::jsonb, $3, 'pending')
       RETURNING id, created_at`,
      [actionType, JSON.stringify(payload), requestedBy],
    );
    const row = r.rows[0];
    return res.status(201).json({ id: row.id, created_at: row.created_at, status: 'pending' });
  } catch (e) {
    if (e.message && e.message.includes('does not exist')) {
      return res.status(503).json({
        error: 'naboto_pending_actions table missing',
        hint: 'Run migration 003_naboto_pending_actions.sql',
      });
    }
    console.error('[naboto-proposals]', e.message);
    return res.status(500).json({ error: 'Insert failed' });
  }
}

export async function nabotoProposalsListHandler(req, res) {
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

  const status = typeof req.query.status === 'string' ? req.query.status.trim() : 'pending';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  try {
    const r = await p.query(
      `SELECT id, action_type, payload, requested_by, status, created_at
       FROM naboto_pending_actions
       WHERE status = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [status, limit],
    );
    return res.json({ items: r.rows, count: r.rows.length });
  } catch (e) {
    console.error('[naboto-proposals list]', e.message);
    return res.status(500).json({ error: 'Query failed' });
  }
}
