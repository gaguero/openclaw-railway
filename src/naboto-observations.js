/**

 * NaBoTo — append-only ingest for bot_observations (Postgres).

 * See naboto-pool.js for shared pool.

 */



import { getNabotoPool, nabotoBearerOk } from './naboto-pool.js';

import { nabotoIngestRateLimit } from './naboto-rate-limit.js';



const MAX_TEXT = 32000;



const uuidOrNull = (v) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);



/**

 * Insert one observation row (shared by HTTP handler and bulk admin).

 * @param {import('pg').Pool} pool

 * @param {object} body

 * @returns {Promise<{ ok: true, id: string, created_at: string } | { ok: false, status: number, json: object }>}

 */

export async function insertBotObservation(pool, body) {

  const sourceGroup = typeof body.source_group === 'string' ? body.source_group.trim() : '';

  const messageText = typeof body.message_text === 'string' ? body.message_text : '';

  const messageAuthor =
    typeof body.message_author === 'string' ? body.message_author.trim() || null : null;



  if (!sourceGroup || !messageText.trim()) {

    return {

      ok: false,

      status: 400,

      json: { error: 'Invalid body', required: ['source_group', 'message_text'] },

    };

  }



  if (messageText.length > MAX_TEXT) {

    return {

      ok: false,

      status: 400,

      json: { error: `message_text exceeds ${MAX_TEXT} characters` },

    };

  }



  const detectedType = typeof body.detected_type === 'string' ? body.detected_type.trim() : null;

  const actionTaken = typeof body.action_taken === 'string' ? body.action_taken.trim() : null;

  const linkedReservationId = typeof body.linked_reservation_id === 'string' ? body.linked_reservation_id.trim() : null;

  const linkedGuestId = typeof body.linked_guest_id === 'string' ? body.linked_guest_id.trim() : null;

  let confidence = null;

  if (body.confidence !== undefined && body.confidence !== null) {

    const n = Number(body.confidence);

    if (!Number.isNaN(n)) {

      confidence = n;

    }

  }

  const requiresReview = Boolean(body.requires_review);



  const sql = `

    INSERT INTO bot_observations (

      source_group, message_author, message_text, detected_type,

      linked_reservation_id, linked_guest_id, action_taken, confidence, requires_review

    ) VALUES (

      $1, $2, $3, $4,

      $5::uuid, $6::uuid, $7, $8, $9

    )

    RETURNING id, created_at

  `;



  try {

    const r = await pool.query(sql, [

      sourceGroup,

      messageAuthor,

      messageText,

      detectedType,

      uuidOrNull(linkedReservationId),

      uuidOrNull(linkedGuestId),

      actionTaken,

      confidence,

      requiresReview,

    ]);

    const row = r.rows[0];

    return { ok: true, id: row.id, created_at: row.created_at };

  } catch (e) {

    console.error('[naboto-observations]', e.message);

    return {

      ok: false,

      status: 500,

      json: {

        error: 'Insert failed',

        detail: process.env.NODE_ENV === 'production' ? undefined : e.message,

      },

    };

  }

}



/**

 * Express handler: POST JSON body → INSERT bot_observations

 */

export async function nabotoObservationsHandler(req, res) {

  if (req.method !== 'POST' && req.method !== undefined) {

    return res.status(405).json({ error: 'Method not allowed' });

  }



  if (!process.env.NABOTO_INGEST_SECRET) {

    return res.status(503).json({

      error: 'NaBoTo ingest disabled',

      hint: 'Set NABOTO_INGEST_SECRET in Railway to enable POST /api/naboto/observations',

    });

  }



  const limited = nabotoIngestRateLimit(req);

  if (limited) {

    return res.status(limited.status).json(limited.body);

  }



  if (!nabotoBearerOk(req)) {

    return res.status(401).json({ error: 'Unauthorized' });

  }



  const p = getNabotoPool();

  if (!p) {

    return res.status(503).json({

      error: 'DATABASE_URL not configured',

      hint: 'Link Postgres to this service on Railway',

    });

  }



  const ins = await insertBotObservation(p, req.body || {});

  if (!ins.ok) {

    return res.status(ins.status).json(ins.json);

  }

  return res.status(201).json({

    id: ins.id,

    created_at: ins.created_at,

  });

}



/**

 * Optional readiness: verifies DB connectivity (no auth).

 */

export async function nabotoDbHealthHandler(_req, res) {

  const p = getNabotoPool();

  if (!p) {

    return res.status(503).json({ ok: false, reason: 'no DATABASE_URL' });

  }

  try {

    await p.query('SELECT 1');

    return res.json({ ok: true, table: 'reachable' });

  } catch (e) {

    return res.status(503).json({ ok: false, reason: e.message });

  }

}

