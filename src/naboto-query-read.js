/**
 * NaBoTo — read-only query API for the agent (tools.exec + curl).
 * Auth: Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN> (same as gateway proxy).
 */
import { getGatewayToken } from './gateway.js';
import { getNabotoPool } from './naboto-pool.js';

export function nabotoQueryGatewayAuth(req, res, next) {
  const expected = getGatewayToken();
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'OPENCLAW_GATEWAY_TOKEN not configured' });
  }
  const auth = req.headers.authorization || '';
  const [type, token] = auth.split(/\s+/);
  if (type !== 'Bearer' || token !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

function clampInt(v, def, min, max) {
  const n = parseInt(String(v), 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Strip ILIKE wildcards from user input */
function ilikeFragment(s) {
  return String(s).replace(/[%_\\]/g, '').trim().slice(0, 120);
}

export async function nabotoQueryObservationsHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }

  const limit = clampInt(req.query.limit, 15, 1, 40);
  const hours = clampInt(req.query.hours, 72, 1, 168);
  const qFrag = req.query.q ? ilikeFragment(req.query.q) : '';
  const groupFrag = req.query.group ? ilikeFragment(req.query.group) : '';

  const conds = [`created_at > NOW() - ($1::bigint * INTERVAL '1 hour')`];
  const params = [hours];
  let idx = 2;

  if (qFrag) {
    conds.push(`message_text ILIKE $${idx}`);
    params.push(`%${qFrag}%`);
    idx++;
  }
  if (groupFrag) {
    conds.push(`source_group ILIKE $${idx}`);
    params.push(`%${groupFrag}%`);
    idx++;
  }
  params.push(limit);

  const sql = `
    SELECT id, source_group, message_author,
           left(message_text, 500) AS message_excerpt,
           created_at
    FROM bot_observations
    WHERE ${conds.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT $${idx}
  `;

  try {
    const r = await p.query(sql, params);
    return res.json({ ok: true, count: r.rows.length, rows: r.rows });
  } catch (e) {
    console.error('[naboto-query-read observations]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function nabotoQueryOperaSyncHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }
  const limit = clampInt(req.query.limit, 8, 1, 25);

  const sql = `
    SELECT id, synced_at, emails_found, xmls_processed,
           reservations_created, reservations_updated, triggered_by,
           left(errors::text, 400) AS errors_preview
    FROM opera_sync_log
    ORDER BY synced_at DESC NULLS LAST
    LIMIT $1
  `;

  try {
    const r = await p.query(sql, [limit]);
    return res.json({ ok: true, count: r.rows.length, rows: r.rows });
  } catch (e) {
    console.error('[naboto-query-read opera_sync]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function nabotoQueryArrivalsHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }

  const fromDay = clampInt(req.query.from_day, -1, -30, 60);
  const toDay = clampInt(req.query.to_day, 14, -30, 120);
  if (toDay < fromDay) {
    return res.status(400).json({ ok: false, error: 'to_day must be >= from_day' });
  }

  const limit = clampInt(req.query.limit, 35, 1, 80);

  // NBDT schema: reservations.arrival / .departure, reservations.guest_id → guests.id
  // (see memory/nbdt_postgres_schema_reference.md)
  const primary = `
    SELECT r.id,
           r.arrival::text AS arrival_date,
           r.departure::text AS departure_date,
           r.room,
           r.status,
           g.full_name AS guest_name
    FROM reservations r
    LEFT JOIN guests g ON g.id = r.guest_id
    WHERE r.arrival IS NOT NULL
      AND (r.arrival::date) >= (CURRENT_DATE + ($1::int))
      AND (r.arrival::date) <= (CURRENT_DATE + ($2::int))
    ORDER BY r.arrival ASC
    LIMIT $3
  `;

  const fallback = `
    SELECT r.id,
           r.arrival::text AS arrival_date,
           r.departure::text AS departure_date,
           r.room,
           r.status,
           NULL::text AS guest_name
    FROM reservations r
    WHERE r.arrival IS NOT NULL
      AND (r.arrival::date) >= (CURRENT_DATE + ($1::int))
      AND (r.arrival::date) <= (CURRENT_DATE + ($2::int))
    ORDER BY r.arrival ASC
    LIMIT $3
  `;

  const params = [fromDay, toDay, limit];

  try {
    const r = await p.query(primary, params);
    return res.json({
      ok: true,
      window_days: { from: fromDay, to: toDay },
      count: r.rows.length,
      rows: r.rows,
    });
  } catch (e1) {
    console.warn('[naboto-query-read arrivals] primary query failed:', e1.message);
    try {
      const r = await p.query(fallback, params);
      return res.json({
        ok: true,
        window_days: { from: fromDay, to: toDay },
        count: r.rows.length,
        rows: r.rows,
        note: 'guest join unavailable; guest_name omitted',
      });
    } catch (e2) {
      console.error('[naboto-query-read arrivals]', e2.message);
      return res.status(500).json({
        ok: false,
        error: e2.message,
        hint: 'Check reservations/guests column names in NBDT schema',
      });
    }
  }
}

export async function nabotoQueryIndexHandler(_req, res) {
  return res.json({
    ok: true,
    auth: 'Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN',
    base: 'http://127.0.0.1:${PORT}/api/naboto/query/',
    endpoints: [
      {
        path: 'observations',
        method: 'GET',
        params: { limit: '1-40 default 15', hours: '1-168 default 72', q: 'optional text', group: 'optional source_group' },
      },
      {
        path: 'opera-sync',
        method: 'GET',
        params: { limit: '1-25 default 8' },
      },
      {
        path: 'arrivals',
        method: 'GET',
        params: { from_day: 'offset from today (default -1)', to_day: 'default 14', limit: '1-80 default 35' },
      },
    ],
    appsheet: {
      base: 'http://127.0.0.1:${PORT}/api/naboto/appsheet',
      note: 'Requires APPSHEET_APP_ID, APPSHEET_ACCESS_KEY, APPSHEET_READONLY_TABLES',
      endpoints: [
        { path: '', method: 'GET', desc: 'status + allowlisted table names' },
        { path: 'find/:tableName', method: 'GET', params: { limit: '1-100 default 25' } },
      ],
    },
  });
}
