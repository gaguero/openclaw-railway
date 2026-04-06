/**
 * OpenClaw internal hook: message:preprocessed → NaBoTo bot_observations (HTTP ingest).
 * Loaded by the gateway from /app/hooks (hooks.internal.load.extraDirs).
 */

const PREMERGED_GROUP_JIDS = ['120363039981029480@g.us'];

/** @type {Map<string, number>} */
const dedupe = new Map();
const DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const DEDUPE_MAX = 8000;

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
  const channelId = String(ctx.channelId || '').toLowerCase();
  if (channelId !== 'whatsapp') return null;

  const groupJid = extractWhatsAppGroupJid(ctx.conversationId, ctx.groupId, sessionKey);
  const isGroup = Boolean(ctx.isGroup || groupJid);

  const groupAllowEnv = process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST === '1' ||
    process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST === 'true' ||
    process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST === 'yes';

  if (isGroup && groupAllowEnv) {
    const allowed = new Set([
      ...parseCommaJids(process.env.NABOTO_WA_ALLOWLIST_GROUP_JIDS).map((j) => j.toLowerCase()),
      ...PREMERGED_GROUP_JIDS.map((j) => j.toLowerCase()),
    ]);
    if (!groupJid || !allowed.has(groupJid)) return null;
  }

  if (!isGroup) {
    if (process.env.NABOTO_WA_HOOK_INGEST_DMS === '0' || process.env.NABOTO_WA_HOOK_INGEST_DMS === 'false') {
      return null;
    }
    const dmAllow = parseCommaJids(process.env.NABOTO_WA_HOOK_DM_ALLOWLIST);
    if (dmAllow.length > 0) {
      const digits = extractSenderDigits(ctx.from, ctx.senderId);
      const ok = dmAllow.some((raw) => {
        const d = raw.replace(/\D/g, '');
        return d && digits && (digits.endsWith(d) || d.endsWith(digits));
      });
      if (!ok) return null;
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
    source_group: sourceGroup.slice(0, 500),
    message_author: author ? author.slice(0, 500) : null,
    message_text: messageText,
    detected_type: detectedType,
    requires_review: requiresReview,
  };
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
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.warn('[naboto-wa-observations-hook] ingest HTTP', res.status, txt.slice(0, 200));
      }
    })
    .catch((e) => {
      clearTimeout(t);
      console.warn('[naboto-wa-observations-hook] ingest failed', e.message);
    });
}

/** @param {any} event */
export default async function handler(event) {
  try {
    if (!event || event.type !== 'message') return;
    // `message:preprocessed` — enriched body. `message:received` — raw inbound; needed when the gateway
    // stores group lines for context without running preprocess (silent / no-mention), per OpenClaw hook docs.
    if (event.action !== 'preprocessed' && event.action !== 'received') return;
    const ctx = event.context;
    if (!ctx || typeof ctx !== 'object') return;

    const payload = buildObservationPayload(ctx, event.sessionKey || '');
    if (!payload) return;

    const dk = `${payload.source_group}|${ctx.messageId || ''}|${payload.message_text.slice(0, 160)}`;
    if (dedupeHit(dk)) return;

    setImmediate(() => postIngest(payload));
  } catch (e) {
    console.warn('[naboto-wa-observations-hook]', e.message);
  }
}
