/**
 * OpenClaw internal hook: message:preprocessed → NaBoTo bot_observations (HTTP ingest).
 * Loaded by the gateway from /app/hooks (hooks.internal.load.extraDirs).
 */

const PREMERGED_GROUP_JIDS = ['120363039981029480@g.us'];

/** @type {Map<string, number>} */
const dedupe = new Map();
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const DEDUPE_MAX = 8000;

function hookIngestDebugEnabled() {
  const v = process.env.NABOTO_WA_HOOK_INGEST_DEBUG;
  return v === '1' || v === 'true' || v === 'yes';
}

function pruneDedupe() {
  const now = Date.now();
  for (const [k, t] of dedupe) {
    if (now - t > DEDUPE_TTL_MS) dedupe.delete(k);
  }
  while (dedupe.size > DEDUPE_MAX) {
    const first = dedupe.keys().next().value;
    if (first === undefined) break;
    dedupe.delete(first);
  }
}

function dedupeHit(key) {
  pruneDedupe();
  const now = Date.now();
  if (dedupe.has(key)) return true;
  dedupe.set(key, now);
  return false;
}

/** @param {string | undefined} raw */
export function parseCommaJids(raw) {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string | undefined} conversationId
 * @param {string | undefined} groupId
 * @param {string | undefined} sessionKey
 */
export function extractWhatsAppGroupJid(conversationId, groupId, sessionKey) {
  const tryOne = (s) => {
    if (!s || typeof s !== 'string') return null;
    // Standard JID: digits@g.us; legacy / multi-device: digits-digits@g.us
    const m = s.match(/([\d-]{8,100}@g\.us)/i);
    return m ? m[1].toLowerCase() : null;
  };
  return (
    tryOne(conversationId) ||
    tryOne(groupId) ||
    tryOne(sessionKey) ||
    null
  );
}

/**
 * @param {string | undefined} from
 * @param {string | undefined} senderId
 * @returns {string | null} digits only for comparison
 */
export function extractSenderDigits(from, senderId) {
  const s = `${from ?? ''} ${senderId ?? ''}`;
  const m = s.match(/(\d{6,15})/g);
  if (!m || m.length === 0) return null;
  return m.sort((a, b) => b.length - a.length)[0] || null;
}

/**
 * Same rules as {@link buildObservationPayload}, but returns a skip reason for diagnostics.
 * @returns {{ ok: true, payload: object } | { ok: false, reason: string, detail?: string }}
 */
export function tryBuildObservationPayload(ctx, sessionKey) {
  if (!ctx || typeof ctx !== 'object') {
    return { ok: false, reason: 'no_context', detail: '' };
  }

  const channelId = String(ctx.channelId || '').toLowerCase();
  if (channelId !== 'whatsapp') {
    return { ok: false, reason: 'channel_not_whatsapp', detail: channelId || '(empty)' };
  }

  const groupJid = extractWhatsAppGroupJid(ctx.conversationId, ctx.groupId, sessionKey);
  const isGroup = Boolean(ctx.isGroup || groupJid);

  const groupAllowEnv =
    process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST === '1' ||
    process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST === 'true' ||
    process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST === 'yes';

  if (isGroup && groupAllowEnv) {
    const allowed = new Set([
      ...parseCommaJids(process.env.NABOTO_WA_ALLOWLIST_GROUP_JIDS).map((j) => j.toLowerCase()),
      ...PREMERGED_GROUP_JIDS.map((j) => j.toLowerCase()),
    ]);
    if (!groupJid) {
      return {
        ok: false,
        reason: 'group_jid_unparsed',
        detail: 'no JID in conversationId/groupId/sessionKey',
      };
    }
    if (!allowed.has(groupJid)) {
      return { ok: false, reason: 'group_not_allowlisted', detail: groupJid };
    }
  }

  if (!isGroup) {
    if (process.env.NABOTO_WA_HOOK_INGEST_DMS === '0' || process.env.NABOTO_WA_HOOK_INGEST_DMS === 'false') {
      return { ok: false, reason: 'dm_ingest_disabled', detail: '' };
    }
    const dmAllow = parseCommaJids(process.env.NABOTO_WA_HOOK_DM_ALLOWLIST);
    if (dmAllow.length > 0) {
      const digits = extractSenderDigits(ctx.from, ctx.senderId);
      const ok = dmAllow.some((raw) => {
        const d = raw.replace(/\D/g, '');
        return d && digits && (digits.endsWith(d) || d.endsWith(digits));
      });
      if (!ok) {
        return { ok: false, reason: 'dm_not_in_allowlist', detail: digits || '(no digits)' };
      }
    }
  }

  const textRaw =
    (typeof ctx.bodyForAgent === 'string' && ctx.bodyForAgent.trim()) ||
    (typeof ctx.transcript === 'string' && ctx.transcript.trim()) ||
    (typeof ctx.body === 'string' && ctx.body.trim()) ||
    (typeof ctx.content === 'string' && ctx.content.trim()) ||
    '';

  const author =
    (typeof ctx.senderName === 'string' && ctx.senderName.trim()) ||
    (typeof ctx.from === 'string' && ctx.from.trim()) ||
    (typeof ctx.senderId === 'string' && ctx.senderId.trim()) ||
    null;

  let sourceGroup;
  if (isGroup && groupJid) {
    sourceGroup = groupJid;
  } else if (!isGroup) {
    sourceGroup = author || extractSenderDigits(ctx.from, ctx.senderId) || 'whatsapp:dm:unknown';
  } else {
    sourceGroup = groupJid || sessionKey.slice(0, 500);
  }

  const idPart = ctx.messageId ? ` ref:${ctx.messageId}` : '';
  let messageText = textRaw;
  let requiresReview = false;

  if (!messageText) {
    messageText = `[WA: sin texto tras preprocesado]${idPart}`.trim();
    requiresReview = true;
  }

  const detectedType = isGroup ? 'wa_live_group' : 'wa_live_dm';

  return {
    ok: true,
    payload: {
      source_group: sourceGroup.slice(0, 500),
      message_author: author ? author.slice(0, 500) : null,
      message_text: messageText,
      detected_type: detectedType,
      requires_review: requiresReview,
    },
  };
}

/**
 * @param {{
 *   channelId?: string,
 *   isGroup?: boolean,
 *   bodyForAgent?: string,
 *   body?: string,
 *   transcript?: string,
 *   conversationId?: string,
 *   groupId?: string,
 *   from?: string,
 *   senderId?: string,
 *   senderName?: string,
 *   messageId?: string,
 * }} ctx
 * @param {string} sessionKey
 */
export function buildObservationPayload(ctx, sessionKey) {
  const r = tryBuildObservationPayload(ctx, sessionKey);
  return r.ok ? r.payload : null;
}

let warnedMissingIngestSecret = false;

function postIngest(body) {
  const secret = process.env.NABOTO_INGEST_SECRET;
  const port = process.env.NABOTO_WRAPPER_PORT || process.env.PORT || '8080';
  if (!secret) {
    if (!warnedMissingIngestSecret) {
      warnedMissingIngestSecret = true;
      console.warn(
        '[naboto-wa-observations-hook] NABOTO_INGEST_SECRET unset — cannot POST /api/naboto/observations (set in Railway)',
      );
    }
    return;
  }

  const url = `http://127.0.0.1:${port}/api/naboto/observations`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);

  fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: ac.signal,
  })
    .then(async (res) => {
      clearTimeout(t);
      if (res.ok) {
        if (hookIngestDebugEnabled()) {
          console.log('[naboto-wa-observations-hook] ingest ok', res.status);
        }
        return;
      }
      const txt = await res.text().catch(() => '');
      console.warn('[naboto-wa-observations-hook] ingest HTTP', res.status, txt.slice(0, 200));
    })
    .catch((e) => {
      clearTimeout(t);
      console.warn('[naboto-wa-observations-hook] ingest failed', e.message);
    });
}

/** @param {any} event */
export default async function handler(event) {
  try {
    const dbg = hookIngestDebugEnabled();
    if (!event || event.type !== 'message') {
      if (dbg) console.log('[naboto-wa-observations-hook] skip event.type', event?.type);
      return;
    }
    // `message:preprocessed` — enriched body. `message:received` — raw inbound; needed when the gateway
    // stores group lines for context without running preprocess (silent / no-mention), per OpenClaw hook docs.
    if (event.action !== 'preprocessed' && event.action !== 'received') {
      if (dbg) console.log('[naboto-wa-observations-hook] skip event.action', event.action);
      return;
    }
    const ctx = event.context;
    if (!ctx || typeof ctx !== 'object') {
      if (dbg) console.log('[naboto-wa-observations-hook] skip no context object');
      return;
    }

    const sk = event.sessionKey || '';
    if (dbg) {
      console.log('[naboto-wa-observations-hook] event', event.action, 'sessionKeyTail', sk.slice(-56));
    }

    const built = tryBuildObservationPayload(ctx, sk);
    if (!built.ok) {
      if (dbg) {
        console.log(
          '[naboto-wa-observations-hook] skip payload',
          built.reason,
          built.detail ? `detail=${built.detail}` : '',
        );
      }
      return;
    }
    const payload = built.payload;

    const dk = `${payload.source_group}|${ctx.messageId || ''}|${payload.message_text.slice(0, 160)}`;
    if (dedupeHit(dk)) {
      if (dbg) console.log('[naboto-wa-observations-hook] skip dedupe', dk.slice(0, 140));
      return;
    }

    setImmediate(() => postIngest(payload));
  } catch (e) {
    console.warn('[naboto-wa-observations-hook]', e.message);
  }
}
