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

function queryBoolTrue(v) {
  const s = String(v ?? '').toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/** Default: hide cancelled / no-show style rows (status fields). */
function includeCancelledFromQuery(req) {
  return queryBoolTrue(req.query.include_cancelled);
}

/** Optional single property filter; returns { clause, param } or null */
function propertyClause(req, paramIndex, tableAlias = '') {
  const raw = req.query.property_id;
  if (raw === undefined || raw === '') return null;
  const id = parseInt(String(raw), 10);
  if (Number.isNaN(id)) return { error: 'invalid property_id' };
  const col = tableAlias ? `${tableAlias}.property_id` : 'property_id';
  return { clause: ` AND ${col} = $${paramIndex}`, param: id };
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
  const includeCancelled = includeCancelledFromQuery(req);
  const prop = propertyClause(req, 4, 'r');
  if (prop?.error) {
    return res.status(400).json({ ok: false, error: prop.error });
  }
  const propSql = prop?.clause ?? '';
  const statusSql = includeCancelled
    ? ''
    : ` AND NOT (
        COALESCE(r.status,'') ~* 'cancel'
        OR COALESCE(r.short_status,'') ~* 'cancel'
        OR COALESCE(r.status,'') ~* 'no[[:space:]-]*show'
        OR COALESCE(r.short_status,'') ~* 'no[[:space:]-]*show'
      )`;

  // NBDT schema: reservations.arrival / .departure, reservations.guest_id → guests.id
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
      ${statusSql}
      ${propSql}
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
      ${statusSql}
      ${propSql}
    ORDER BY r.arrival ASC
    LIMIT $3
  `;

  const params = prop ? [fromDay, toDay, limit, prop.param] : [fromDay, toDay, limit];

  try {
    const r = await p.query(primary, params);
    return res.json({
      ok: true,
      window_days: { from: fromDay, to: toDay },
      filters_applied: {
        exclude_cancelled_and_no_show: !includeCancelled,
        property_id: prop ? prop.param : null,
      },
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
        filters_applied: {
          exclude_cancelled_and_no_show: !includeCancelled,
          property_id: prop ? prop.param : null,
        },
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

function dayWindowOr400(req) {
  const fromDay = clampInt(req.query.from_day, -1, -30, 60);
  const toDay = clampInt(req.query.to_day, 14, -30, 120);
  if (toDay < fromDay) {
    return { error: 'to_day must be >= from_day' };
  }
  const limit = clampInt(req.query.limit, 30, 1, 80);
  return { fromDay, toDay, limit };
}

export async function nabotoQueryToursHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }
  const w = dayWindowOr400(req);
  if (w.error) {
    return res.status(400).json({ ok: false, error: w.error });
  }
  const { fromDay, toDay, limit } = w;
  const includeCancelled = includeCancelledFromQuery(req);
  const prop = propertyClause(req, 4, 'b');
  if (prop?.error) {
    return res.status(400).json({ ok: false, error: prop.error });
  }
  const cancelSql = includeCancelled
    ? ''
    : ` AND NOT (
        COALESCE(b.guest_status,'') ~* 'cancel'
        OR COALESCE(b.vendor_status,'') ~* 'cancel'
      )`;
  const propSql = prop?.clause ?? '';
  const sql = `
    SELECT b.id,
           COALESCE(b.activity_date, s.date)::text AS activity_date,
           b.start_time,
           b.num_guests,
           b.total_price,
           b.guest_status,
           b.vendor_status,
           left(b.special_requests, 400) AS special_requests_excerpt,
           b.legacy_activity_name,
           p.name_en AS product_name_en,
           p.name_es AS product_name_es,
           g.full_name AS guest_name
    FROM tour_bookings b
    LEFT JOIN tour_schedules s ON s.id = b.schedule_id
    LEFT JOIN tour_products p ON p.id = b.product_id
    LEFT JOIN guests g ON g.id = b.guest_id
    WHERE COALESCE(b.activity_date, s.date) IS NOT NULL
      AND (COALESCE(b.activity_date, s.date)::date) >= (CURRENT_DATE + ($1::int))
      AND (COALESCE(b.activity_date, s.date)::date) <= (CURRENT_DATE + ($2::int))
      ${cancelSql}
      ${propSql}
    ORDER BY COALESCE(b.activity_date, s.date), b.start_time NULLS LAST
    LIMIT $3
  `;
  const params = prop ? [fromDay, toDay, limit, prop.param] : [fromDay, toDay, limit];
  try {
    const r = await p.query(sql, params);
    return res.json({
      ok: true,
      domain: 'tour_bookings',
      window_days: { from: fromDay, to: toDay },
      filters_applied: {
        exclude_cancelled_status: !includeCancelled,
        property_id: prop ? prop.param : null,
      },
      count: r.rows.length,
      rows: r.rows,
    });
  } catch (e) {
    console.error('[naboto-query-read tours]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function nabotoQueryMassagesHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }
  const w = dayWindowOr400(req);
  if (w.error) {
    return res.status(400).json({ ok: false, error: w.error });
  }
  const { fromDay, toDay, limit } = w;
  const allServices = queryBoolTrue(req.query.all_services);
  const includeCancelled = includeCancelledFromQuery(req);
  const qFrag = req.query.q ? ilikeFragment(req.query.q) : '';

  const params = [fromDay, toDay, limit];
  let next = 4;
  let qClause = '';
  if (qFrag.length >= 2) {
    qClause = ` AND (mi.name_en ILIKE $${next} OR mi.name_es ILIKE $${next} OR b.guest_name ILIKE $${next})`;
    params.push(`%${qFrag}%`);
    next++;
  }
  const prop = propertyClause(req, next, 'b');
  if (prop?.error) {
    return res.status(400).json({ ok: false, error: prop.error });
  }
  const propSql = prop?.clause ?? '';
  if (prop) params.push(prop.param);

  const heuristicSql =
    allServices || qFrag.length >= 2
      ? ''
      : ` AND mi.id IS NOT NULL AND (
            mi.name_en ~* 'massage|masaje|spa|facial|therapy|terapia|wellness'
            OR mi.name_es ~* 'massage|masaje|spa|facial|therapy|terapia|wellness'
            OR COALESCE(mi.item_type,'') ~* 'spa|wellness|therapy'
          )`;
  const bookingStatusSql = includeCancelled
    ? ''
    : ` AND NOT (COALESCE(b.status,'') ~* 'cancel|no[[:space:]-]*show')`;

  const sql = `
    SELECT b.id,
           b.booking_date::text,
           b.booking_time,
           b.end_time,
           b.guest_name,
           b.number_of_guests,
           b.status,
           left(b.special_requests, 300) AS special_requests_excerpt,
           mi.name_en AS item_name_en,
           mi.name_es AS item_name_es,
           mi.item_type,
           mi.duration_minutes
    FROM bookings b
    LEFT JOIN menu_items mi ON mi.id = b.item_id
    WHERE b.booking_date IS NOT NULL
      AND (b.booking_date::date) >= (CURRENT_DATE + ($1::int))
      AND (b.booking_date::date) <= (CURRENT_DATE + ($2::int))
      ${bookingStatusSql}
      ${heuristicSql}
      ${qClause}
      ${propSql}
    ORDER BY b.booking_date, b.booking_time NULLS LAST
    LIMIT $3
  `;

  try {
    const r = await p.query(sql, params);
    return res.json({
      ok: true,
      domain: 'bookings',
      note: allServices
        ? 'all_services=1: any menu booking in window (still respects cancel filter).'
        : 'Default: spa/massage-like menu_items only; use all_services=1 for all bookings, or q= to match item/guest name.',
      window_days: { from: fromDay, to: toDay },
      filters_applied: {
        all_services: allServices,
        q: qFrag || null,
        exclude_cancelled_booking_status: !includeCancelled,
        property_id: prop ? prop.param : null,
      },
      count: r.rows.length,
      rows: r.rows,
    });
  } catch (e) {
    console.error('[naboto-query-read massages]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function nabotoQueryTransfersHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }
  const w = dayWindowOr400(req);
  if (w.error) {
    return res.status(400).json({ ok: false, error: w.error });
  }
  const { fromDay, toDay, limit } = w;
  const includeCancelled = includeCancelledFromQuery(req);
  const prop = propertyClause(req, 4, 't');
  if (prop?.error) {
    return res.status(400).json({ ok: false, error: prop.error });
  }
  const cancelSql = includeCancelled
    ? ''
    : ` AND NOT (
        COALESCE(t.guest_status,'') ~* 'cancel'
        OR COALESCE(t.vendor_status,'') ~* 'cancel'
      )`;
  const propSql = prop?.clause ?? '';
  const sql = `
    SELECT t.id,
           t.date::text,
           t.time,
           t.origin,
           t.destination,
           t.transfer_type,
           t.num_passengers,
           t.flight_number,
           t.guest_status,
           t.vendor_status,
           left(t.notes, 400) AS notes_excerpt,
           g.full_name AS guest_name
    FROM transfers t
    LEFT JOIN guests g ON g.id = t.guest_id
    WHERE t.date IS NOT NULL
      AND (t.date::date) >= (CURRENT_DATE + ($1::int))
      AND (t.date::date) <= (CURRENT_DATE + ($2::int))
      ${cancelSql}
      ${propSql}
    ORDER BY t.date, t.time NULLS LAST
    LIMIT $3
  `;
  const params = prop ? [fromDay, toDay, limit, prop.param] : [fromDay, toDay, limit];
  try {
    const r = await p.query(sql, params);
    return res.json({
      ok: true,
      domain: 'transfers',
      window_days: { from: fromDay, to: toDay },
      filters_applied: {
        exclude_cancelled_status: !includeCancelled,
        property_id: prop ? prop.param : null,
      },
      count: r.rows.length,
      rows: r.rows,
    });
  } catch (e) {
    console.error('[naboto-query-read transfers]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function nabotoQueryOtherHotelsHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }
  const w = dayWindowOr400(req);
  if (w.error) {
    return res.status(400).json({ ok: false, error: w.error });
  }
  const { fromDay, toDay, limit } = w;
  const includeCancelled = includeCancelledFromQuery(req);
  const prop = propertyClause(req, 4, 'o');
  if (prop?.error) {
    return res.status(400).json({ ok: false, error: prop.error });
  }
  const cancelSql = includeCancelled
    ? ''
    : ` AND NOT (
        COALESCE(o.guest_status,'') ~* 'cancel'
        OR COALESCE(o.vendor_status,'') ~* 'cancel'
      )`;
  const propSql = prop?.clause ?? '';
  const sql = `
    SELECT o.id,
           o.date::text,
           o.checkin::text,
           o.checkout::text,
           o.num_guests,
           o.hotel_id,
           o.guest_status,
           o.vendor_status,
           o.price,
           left(o.notes, 400) AS notes_excerpt,
           g.full_name AS guest_name,
           ph.name AS partner_hotel_name
    FROM other_hotel_bookings o
    LEFT JOIN guests g ON g.id = o.guest_id
    LEFT JOIN partner_hotels ph ON ph.id = o.hotel_id
    WHERE COALESCE(o.date::date, o.checkin::date) IS NOT NULL
      AND COALESCE(o.date::date, o.checkin::date) >= (CURRENT_DATE + ($1::int))
      AND COALESCE(o.date::date, o.checkin::date) <= (CURRENT_DATE + ($2::int))
      ${cancelSql}
      ${propSql}
    ORDER BY COALESCE(o.date::date, o.checkin::date)
    LIMIT $3
  `;
  const params = prop ? [fromDay, toDay, limit, prop.param] : [fromDay, toDay, limit];
  try {
    const r = await p.query(sql, params);
    return res.json({
      ok: true,
      domain: 'other_hotel_bookings',
      window_days: { from: fromDay, to: toDay },
      filters_applied: {
        exclude_cancelled_status: !includeCancelled,
        property_id: prop ? prop.param : null,
        date_field: 'COALESCE(date, checkin)',
      },
      count: r.rows.length,
      rows: r.rows,
    });
  } catch (e) {
    console.error('[naboto-query-read other-hotels]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function nabotoQuerySpecialRequestsHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }
  const w = dayWindowOr400(req);
  if (w.error) {
    return res.status(400).json({ ok: false, error: w.error });
  }
  const { fromDay, toDay, limit } = w;
  const includeCancelled = includeCancelledFromQuery(req);
  const deptFrag = req.query.department ? ilikeFragment(req.query.department) : '';

  const params = [fromDay, toDay, limit];
  let next = 4;
  let deptSql = '';
  if (deptFrag) {
    deptSql = ` AND s.department ILIKE $${next}`;
    params.push(`%${deptFrag}%`);
    next++;
  }
  const prop = propertyClause(req, next, 's');
  if (prop?.error) {
    return res.status(400).json({ ok: false, error: prop.error });
  }
  const propSql = prop?.clause ?? '';
  if (prop) params.push(prop.param);

  const cancelSql = includeCancelled
    ? ''
    : ` AND NOT (COALESCE(s.status,'') ~* 'cancel|closed|resolved')`;

  const sql = `
    SELECT s.id,
           s.date::text,
           s.time,
           s.department,
           s.status,
           left(s.request, 500) AS request_excerpt,
           s.assigned_to,
           g.full_name AS guest_name
    FROM special_requests s
    LEFT JOIN guests g ON g.id = s.guest_id
    WHERE s.date IS NOT NULL
      AND (s.date::date) >= (CURRENT_DATE + ($1::int))
      AND (s.date::date) <= (CURRENT_DATE + ($2::int))
      ${cancelSql}
      ${deptSql}
      ${propSql}
    ORDER BY s.date, s.time NULLS LAST
    LIMIT $3
  `;

  try {
    const r = await p.query(sql, params);
    return res.json({
      ok: true,
      domain: 'special_requests',
      window_days: { from: fromDay, to: toDay },
      filters_applied: {
        exclude_done_like_status: !includeCancelled,
        note: 'include_cancelled=1 also disables hiding closed/resolved/cancel special_requests',
        department_ilike: deptFrag || null,
        property_id: prop ? prop.param : null,
      },
      count: r.rows.length,
      rows: r.rows,
    });
  } catch (e) {
    console.error('[naboto-query-read special-requests]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function nabotoQueryRomanticDinnersHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }
  const w = dayWindowOr400(req);
  if (w.error) {
    return res.status(400).json({ ok: false, error: w.error });
  }
  const { fromDay, toDay, limit } = w;
  const includeCancelled = includeCancelledFromQuery(req);
  const prop = propertyClause(req, 4, 'd');
  if (prop?.error) {
    return res.status(400).json({ ok: false, error: prop.error });
  }
  const cancelSql = includeCancelled ? '' : ` AND NOT (COALESCE(d.status,'') ~* 'cancel')`;
  const propSql = prop?.clause ?? '';
  const sql = `
    SELECT d.id,
           d.date::text,
           d.time,
           d.location,
           d.status,
           d.num_guests,
           d.price,
           left(d.notes, 400) AS notes_excerpt,
           g.full_name AS guest_name
    FROM romantic_dinners d
    LEFT JOIN guests g ON g.id = d.guest_id
    WHERE d.date IS NOT NULL
      AND (d.date::date) >= (CURRENT_DATE + ($1::int))
      AND (d.date::date) <= (CURRENT_DATE + ($2::int))
      ${cancelSql}
      ${propSql}
    ORDER BY d.date, d.time NULLS LAST
    LIMIT $3
  `;
  const params = prop ? [fromDay, toDay, limit, prop.param] : [fromDay, toDay, limit];
  try {
    const r = await p.query(sql, params);
    return res.json({
      ok: true,
      domain: 'romantic_dinners',
      window_days: { from: fromDay, to: toDay },
      filters_applied: {
        exclude_cancelled_status: !includeCancelled,
        property_id: prop ? prop.param : null,
      },
      count: r.rows.length,
      rows: r.rows,
    });
  } catch (e) {
    console.error('[naboto-query-read romantic-dinners]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function nabotoQueryGuestsHandler(req, res) {
  const p = getNabotoPool();
  if (!p) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }
  const gidRaw = req.query.guest_id;
  const rawSearch = req.query.q ?? req.query.name;
  const qFrag = rawSearch != null && rawSearch !== '' ? ilikeFragment(String(rawSearch)) : '';
  const limit = clampInt(req.query.limit, 15, 1, 40);

  if (gidRaw !== undefined && gidRaw !== '') {
    const gid = parseInt(String(gidRaw), 10);
    if (Number.isNaN(gid)) {
      return res.status(400).json({ ok: false, error: 'guest_id must be a number' });
    }
    const prop = propertyClause(req, 2);
    if (prop?.error) {
      return res.status(400).json({ ok: false, error: prop.error });
    }
    const sql = `
      SELECT id, full_name, first_name, last_name, nationality, companion_name, profile_type,
             property_id, opera_profile_id, email, phone,
             left(notes, 500) AS notes_excerpt
      FROM guests
      WHERE id = $1
        ${prop?.clause ?? ''}
      LIMIT 1
    `;
    const params = prop ? [gid, prop.param] : [gid];
    try {
      const r = await p.query(sql, params);
      return res.json({
        ok: true,
        domain: 'guests',
        filters_applied: { guest_id: gid, property_id: prop ? prop.param : null },
        count: r.rows.length,
        rows: r.rows,
      });
    } catch (e) {
      console.error('[naboto-query-read guests]', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  if (qFrag.length < 2) {
    return res.status(400).json({
      ok: false,
      error:
        'Provide guest_id, or q / name (min 2 characters after sanitizing wildcards). ' +
        'Tip: put the curl URL in double quotes and encode spaces as %20 (e.g. q=Yuwen%20Wu).',
    });
  }

  const prop = propertyClause(req, 3);
  if (prop?.error) {
    return res.status(400).json({ ok: false, error: prop.error });
  }

  const sql = `
    SELECT id, full_name, first_name, last_name, nationality, companion_name, profile_type,
           property_id, opera_profile_id, email, phone,
           left(notes, 400) AS notes_excerpt
    FROM guests
    WHERE (
      full_name ILIKE $1
      OR first_name ILIKE $1
      OR last_name ILIKE $1
      OR (COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) ILIKE $1
    )
    ${prop?.clause ?? ''}
    ORDER BY full_name NULLS LAST
    LIMIT $2
  `;
  const like = `%${qFrag}%`;
  const params = prop ? [like, limit, prop.param] : [like, limit];
  try {
    const r = await p.query(sql, params);
    const searchParam =
      req.query.q != null && String(req.query.q) !== '' ? 'q' : 'name';
    return res.json({
      ok: true,
      domain: 'guests',
      filters_applied: {
        search: qFrag,
        search_param: searchParam,
        property_id: prop ? prop.param : null,
        limit,
      },
      count: r.rows.length,
      rows: r.rows,
    });
  } catch (e) {
    console.error('[naboto-query-read guests]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

export async function nabotoQueryIndexHandler(_req, res) {
  return res.json({
    ok: true,
    auth: 'Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN',
    base: 'Use host:port from NABOTO_WRAPPER_PORT or PORT — path prefix /api/naboto/query/',
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
        params: {
          from_day: 'default -1',
          to_day: 'default 14',
          limit: '1-80 default 35',
          include_cancelled: '1 to include cancel/no-show',
          property_id: 'optional',
        },
      },
      {
        path: 'tours',
        method: 'GET',
        params: {
          from_day: 'default -1',
          to_day: 'default 14',
          limit: '1-80 default 30',
          include_cancelled: 'optional',
          property_id: 'optional',
        },
      },
      {
        path: 'massages',
        method: 'GET',
        params: {
          from_day: 'default -1',
          to_day: 'default 14',
          limit: '1-80 default 30',
          all_services: '1 = any bookings table row in window',
          q: 'optional ILIKE on item or guest_name',
          include_cancelled: 'optional',
          property_id: 'optional',
        },
      },
      {
        path: 'transfers',
        method: 'GET',
        params: { from_day: 'default -1', to_day: 'default 14', limit: '1-80 default 30', include_cancelled: 'optional', property_id: 'optional' },
      },
      {
        path: 'other-hotels',
        method: 'GET',
        params: { from_day: 'default -1', to_day: 'default 14', limit: '1-80 default 30', include_cancelled: 'optional', property_id: 'optional' },
      },
      {
        path: 'special-requests',
        method: 'GET',
        params: {
          from_day: 'default -1',
          to_day: 'default 14',
          limit: '1-80 default 30',
          department: 'optional ILIKE fragment',
          include_cancelled: '1 also shows closed/resolved',
          property_id: 'optional',
        },
      },
      {
        path: 'romantic-dinners',
        method: 'GET',
        params: { from_day: 'default -1', to_day: 'default 14', limit: '1-80 default 30', include_cancelled: 'optional', property_id: 'optional' },
      },
      {
        path: 'guests',
        method: 'GET',
        params: {
          guest_id: 'exact id',
          q: 'min 2 chars name search',
          name: 'alias of q (same ILIKE search)',
          limit: '1-40 default 15',
          property_id: 'optional',
        },
      },
    ],
    appsheet: {
      base: 'Same host as query API — /api/naboto/appsheet',
      note: 'Requires APPSHEET_APP_ID, APPSHEET_ACCESS_KEY, APPSHEET_READONLY_TABLES',
      endpoints: [
        { path: '', method: 'GET', desc: 'status + allowlisted table names' },
        { path: 'find/:tableName', method: 'GET', params: { limit: '1-100 default 25' } },
      ],
    },
    admin_wa: {
      base: 'Same Bearer as query API — OPENCLAW_GATEWAY_TOKEN',
      note: 'Chat agent: tool exec + curl. Ingest from JSONL baked in image; parse accepts raw export text (size limit ~2MB).',
      endpoints: [
        {
          path: '/api/naboto/admin/wa-jsonl-ingest',
          method: 'GET',
          note: 'dry-run only — same as POST with dry_run true; works when exec maps curl to fetch GET',
          query: { source: 'preview', limit: 'optional max rows to count' },
        },
        {
          path: '/api/naboto/admin/wa-jsonl-ingest',
          method: 'POST',
          body: {
            source: 'preview (see server WA_JSONL_SOURCES)',
            dry_run: 'true to count only; false inserts rows',
            limit: 'max rows to insert or simulate (default 5000 cap)',
          },
        },
        {
          path: '/api/naboto/admin/wa-parse',
          method: 'POST',
          body: { text: 'full WA GROUPS .txt export' },
          returns: 'sections count, records count, sample rows (no DB write)',
        },
      ],
    },
  });
}
