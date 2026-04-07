/**
 * NaBoTo — persist WhatsApp transcript rows to bot_observations in near real time.
 * 1) OpenClaw internal hook `message:preprocessed` (`hooks/naboto-wa-observations` → HTTP ingest) when enabled.
 * 2) WebSocket `session.message` when the gateway emits it.
 * 3) Fallback: periodic `sessions.preview` RPC (tail of transcript) — WA often buffers context
 *    without emitting `session.message`, so WS alone can miss rows.
 *
 * Disable: NABOTO_WA_LIVE_INGEST=0
 * NABOTO_WA_SESSION_REFRESH_MS: re-run sessions.list + subscribe (default 60000). 0 = off.
 * NABOTO_WA_PREVIEW_POLL_MS: `sessions.preview` interval (default 25000). 0 = off.
 * NABOTO_WA_PREVIEW_LIMIT / NABOTO_WA_PREVIEW_MAX_CHARS: passed to `sessions.preview` (defaults 30 / 2000).
 * NABOTO_WA_LIVE_INGEST_DEBUG=1: log session.message payloads missing session key.
 * NABOTO_WA_LIVE_INGEST_SKIP_LOG=1: log why a transcript/preview row did not become a bot_observations insert (noisy).
 * NABOTO_WA_PREVIEW_STRICT_ROLES=1: in sessions.preview polling, skip role=assistant (legacy; default allows assistant — WA context rows often use assistant).
 */

import WebSocket from 'ws';
import { getGatewayToken } from './gateway.js';
import { getNabotoPool } from './naboto-pool.js';
import { insertBotObservation, NABOTO_MAX_MESSAGE_TEXT } from './naboto-observations.js';

const INTERNAL = process.env.INTERNAL_GATEWAY_PORT || '18789';

/** Re-list sessions and subscribe to new WhatsApp keys (e.g. after WA hydrates groups). 0 = off. */
function sessionRefreshIntervalMs() {
  const v = process.env.NABOTO_WA_SESSION_REFRESH_MS;
  if (v === '0' || v === 'false' || v === 'off') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return 60_000;
}

/** Poll transcript tail via `sessions.preview`. 0 = rely on WS only. */
function previewPollIntervalMs() {
  const v = process.env.NABOTO_WA_PREVIEW_POLL_MS;
  if (v === '0' || v === 'false' || v === 'off') return 0;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return n;
  return 25_000;
}

function previewRpcLimit() {
  const n = Number(process.env.NABOTO_WA_PREVIEW_LIMIT);
  if (Number.isFinite(n) && n >= 1 && n <= 50) return Math.floor(n);
  return 30;
}

function previewRpcMaxChars() {
  const n = Number(process.env.NABOTO_WA_PREVIEW_MAX_CHARS);
  if (Number.isFinite(n) && n >= 20 && n <= 2000) return Math.floor(n);
  return 2000;
}

/** @returns {boolean} */
export function waLiveIngestEnabled() {
  const v = process.env.NABOTO_WA_LIVE_INGEST;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return Boolean(getNabotoPool());
}

function liveIngestSkipLogEnabled() {
  const v = process.env.NABOTO_WA_LIVE_INGEST_SKIP_LOG;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isWhatsAppIngestSessionKey(key) {
  if (typeof key !== 'string') return false;
  const k = key.toLowerCase();
  if (!k.includes('whatsapp')) return false;
  if (k.includes(':cron:')) return false;
  return k.includes('group:') || k.includes(':direct:');
}

/**
 * @param {string} sessionKey
 * @returns {string}
 */
export function sourceGroupFromSessionKey(sessionKey) {
  const g = sessionKey.match(/group:([^\s]+)$/i);
  if (g) return g[1].slice(0, 500);
  const d = sessionKey.match(/direct:([^\s]+)$/i);
  if (d) return d[1].slice(0, 500);
  return sessionKey.slice(0, 500);
}

/**
 * @param {string} sessionKey
 * @returns {string}
 */
export function detectedTypeForSessionKey(sessionKey) {
  const k = sessionKey.toLowerCase();
  if (k.includes('group:')) return 'wa_live_group';
  if (k.includes(':direct:')) return 'wa_live_dm';
  return 'wa_live';
}

/**
 * @param {unknown} content
 * @returns {string}
 */
export function extractTextFromMessageContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === 'string') parts.push(p);
      else if (p && typeof p === 'object') {
        if (typeof p.text === 'string') parts.push(p.text);
        else if (typeof p.content === 'string') parts.push(p.content);
      }
    }
    return parts.join('\n').trim();
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * Normalize one transcript row from session.message payload.
 * @param {object} msg
 * @returns {{ role: string, text: string, author: string | null, id: string }}
 */
export function normalizeTranscriptRow(msg) {
  if (!msg || typeof msg !== 'object') {
    return { role: '', text: '', author: null, id: '' };
  }
  const role = String(msg.role || msg.kind || '').toLowerCase();
  const text =
    extractTextFromMessageContent(msg.content) ||
    (typeof msg.text === 'string' ? msg.text : '') ||
    (typeof msg.body === 'string' ? msg.body : '');
  const author =
    (typeof msg.author === 'string' && msg.author.trim()) ||
    (typeof msg.name === 'string' && msg.name.trim()) ||
    (typeof msg.from === 'string' && msg.from.trim()) ||
    (msg.meta && typeof msg.meta.pushName === 'string' && msg.meta.pushName.trim()) ||
    null;
  const id =
    (typeof msg.id === 'string' && msg.id) ||
    (typeof msg.messageId === 'string' && msg.messageId) ||
    (msg.meta && typeof msg.meta.id === 'string' && msg.meta.id) ||
    '';
  return {
    role,
    text: String(text || '').trim(),
    author: author ? author.slice(0, 500) : null,
    id,
  };
}

/**
 * @param {object} payload
 * @returns {string | null}
 */
export function sessionKeyFromEventPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.sessionKey === 'string') return payload.sessionKey;
  if (typeof payload.key === 'string') return payload.key;
  if (payload.session && typeof payload.session.key === 'string') return payload.session.key;
  return null;
}

/**
 * @param {object} payload
 * @returns {object | null}
 */
export function messageObjectFromEventPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.message && typeof payload.message === 'object') return payload.message;
  if (payload.entry && typeof payload.entry === 'object') return payload.entry;
  if (payload.delta && typeof payload.delta === 'object') return payload.delta;
  return payload;
}

/**
 * Truncate for Postgres `message_text` (same cap as insertBotObservation).
 * @param {string} s
 * @param {number} [maxLen]
 * @returns {string}
 */
export function truncateObservationText(s, maxLen = NABOTO_MAX_MESSAGE_TEXT) {
  const t = typeof s === 'string' ? s : String(s ?? '');
  if (t.length <= maxLen) return t;
  const note = `\n...[truncado; longitud original ${t.length} caracteres]`;
  const head = maxLen - note.length;
  if (head < 200) return t.slice(0, maxLen);
  return t.slice(0, head) + note;
}

/**
 * Raw text from a `sessions.preview` row (OpenClaw may use `text` or `content`).
 * @param {object | null | undefined} item
 * @returns {string}
 */
export function previewItemRawText(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (typeof item.body === 'string') return item.body;
  return '';
}

/**
 * Diff tail of `sessions.preview` items so we only ingest new rows (and survive dedupe clearing).
 * @param {string[] | undefined} prevSigs
 * @param {Array<{ role?: string, text?: string, content?: string }>} items
 * @returns {{ newItems: Array<{ role?: string, text?: string, content?: string }>, nextSigs: string[] }}
 */
export function previewItemsNewSincePrevious(prevSigs, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { newItems: [], nextSigs: Array.isArray(prevSigs) ? [...prevSigs] : [] };
  }
  const currSigs = items.map((it) => `${String(it?.role ?? '')}|${previewItemRawText(it)}`);
  const prev = Array.isArray(prevSigs) ? prevSigs : [];
  let k = 0;
  for (let tryK = Math.min(prev.length, currSigs.length); tryK >= 1; tryK -= 1) {
    let ok = true;
    for (let i = 0; i < tryK; i += 1) {
      if (prev[prev.length - tryK + i] !== currSigs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      k = tryK;
      break;
    }
  }
  return { newItems: items.slice(k), nextSigs: currSigs };
}

/**
 * @param {object} msg
 * @returns {boolean}
 */
export function isWaRevokeOrDelete(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.revoked === true || msg.deleted === true) return true;
  const stub = msg.messageStubType ?? msg.stubType;
  if (stub === 1 || stub === 'REVOKE' || stub === 'revoke') return true;
  const t = String(msg.type || '').toLowerCase();
  const e = String(msg.event || '').toLowerCase();
  if (t === 'revoke' || e === 'revoke' || e === 'delete') return true;
  return false;
}

/**
 * @param {object} msg
 * @returns {boolean}
 */
export function isWaEdit(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.edited === true) return true;
  if (msg.editedAt != null || msg.edited_at != null) return true;
  const t = String(msg.type || '').toLowerCase();
  const e = String(msg.event || '').toLowerCase();
  return t === 'edit' || e === 'edit';
}

/**
 * @param {object} msg
 * @returns {string | null} short Spanish label for media kind
 */
export function detectWaMediaKind(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const mime = String(msg.mimetype || msg.mimeType || '').toLowerCase();
  const mt = String(msg.mediaType || msg.messageType || '').toLowerCase();
  const typRaw = String(msg.type || '').toLowerCase();
  const ignoreTyp = ['user', 'text', 'chat', 'human', 'assistant', 'tool', 'system', ''].includes(typRaw);
  const typ = ignoreTyp ? '' : typRaw;
  if (mime.startsWith('image/') || mt === 'image' || typ === 'image') return 'imagen';
  if (mime.startsWith('video/') || mt === 'video' || typ === 'video') return 'video';
  if (mime.startsWith('audio/') || mt === 'audio' || mt === 'ptt' || mt === 'voice' || typ === 'audio' || typ === 'ptt') {
    return 'audio';
  }
  if (mt === 'sticker' || typ === 'sticker') return 'sticker';
  if (mime.startsWith('application/') || mt === 'document' || typ === 'document') return 'documento';
  if (mt === 'location' || typ === 'location') return 'ubicacion';
  if (mt === 'contact' || mt === 'vcard' || typ === 'contact' || typ === 'vcard') return 'contacto';
  if (mt === 'poll' || typ === 'poll') return 'encuesta';
  return null;
}

/**
 * Caption / filename hints not always in `content`.
 * @param {object} msg
 * @returns {string}
 */
export function extractWaCaptionAndMeta(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const parts = [];
  const cap =
    (typeof msg.caption === 'string' && msg.caption.trim()) ||
    (typeof msg.description === 'string' && msg.description.trim()) ||
    '';
  if (cap) parts.push(cap);
  const fn = typeof msg.fileName === 'string' ? msg.fileName.trim() : typeof msg.file_name === 'string' ? msg.file_name.trim() : '';
  if (fn) parts.push(`archivo:${fn}`);
  const mime = typeof msg.mimetype === 'string' ? msg.mimetype.trim() : typeof msg.mimeType === 'string' ? msg.mimeType.trim() : '';
  if (mime && !cap) parts.push(`mime:${mime}`);
  return parts.join(' | ').trim();
}

function previewPollingStrictAssistantRole() {
  const v = process.env.NABOTO_WA_PREVIEW_STRICT_ROLES;
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Build DB row fields from a gateway transcript row (best-effort for WA quirks).
 * @param {object} rawMsg
 * @param {string} sessionKey
 * @param {{ fromPreviewPolling?: boolean }} [options] fromPreviewPolling: from `sessions.preview` tail — often labels context as role=assistant; default ingests those rows unless NABOTO_WA_PREVIEW_STRICT_ROLES=1.
 * @returns {{ source_group: string, message_author: string | null, message_text: string, detected_type: string, requires_review?: boolean } | null}
 */
export function buildWaLiveObservationBody(rawMsg, sessionKey, options = {}) {
  if (!rawMsg || typeof rawMsg !== 'object') return null;
  const row = normalizeTranscriptRow(rawMsg);
  if (row.role === 'tool' || row.role === 'system') return null;
  const fromPreview = Boolean(options.fromPreviewPolling);
  const skipAssistant = !fromPreview || previewPollingStrictAssistantRole();
  if (skipAssistant && row.role === 'assistant') return null;

  const base = detectedTypeForSessionKey(sessionKey);
  const sg = sourceGroupFromSessionKey(sessionKey);
  const idPart = row.id ? ` ref:${row.id}` : '';

  if (isWaRevokeOrDelete(rawMsg)) {
    return {
      source_group: sg,
      message_author: row.author,
      message_text: truncateObservationText(`[WA: mensaje eliminado]${idPart}`.trim()),
      detected_type: `${base}_revoke`,
    };
  }

  const mediaKind = detectWaMediaKind(rawMsg);
  const extra = extractWaCaptionAndMeta(rawMsg);
  const bodyText = row.text || extra;

  if (isWaEdit(rawMsg)) {
    if (!bodyText) return null;
    return {
      source_group: sg,
      message_author: row.author,
      message_text: truncateObservationText(`[WA: editado] ${bodyText}`),
      detected_type: `${base}_edit`,
    };
  }

  if (mediaKind) {
    const label = `[WA: ${mediaKind}]`;
    const combined = [label, bodyText || extra].filter(Boolean).join(' ').trim();
    const hasCaption =
      (typeof rawMsg.caption === 'string' && rawMsg.caption.trim()) ||
      (typeof rawMsg.description === 'string' && rawMsg.description.trim());
    const hasUserText = Boolean(row.text && String(row.text).trim());
    return {
      source_group: sg,
      message_author: row.author,
      message_text: truncateObservationText(combined || label),
      detected_type: `${base}_media`,
      requires_review: !hasUserText && !hasCaption,
    };
  }

  if (!bodyText) return null;

  return {
    source_group: sg,
    message_author: row.author,
    message_text: truncateObservationText(bodyText),
    detected_type: base,
  };
}

let stopRequested = false;
let reconnectTimer = null;
/** @type {WebSocket | null} */
let wsRef = null;

/**
 * Parse sessions.list payload → array of { key }.
 * @param {unknown} payload
 * @returns {string[]}
 */
function sessionKeysFromListPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.map((s) => (typeof s === 'object' && s && typeof s.key === 'string' ? s.key : null)).filter(Boolean);
  }
  const sessions = payload.sessions || payload.items || payload.rows;
  if (!Array.isArray(sessions)) return [];
  return sessions.map((s) => (typeof s === 'object' && s && typeof s.key === 'string' ? s.key : null)).filter(Boolean);
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} sessionKey
 * @param {object} payload
 * @param {Set<string>} dedupe
 * @param {{ fromPreviewPolling?: boolean }} [buildOpts]
 */
async function maybeIngestSessionMessage(pool, sessionKey, payload, dedupe, buildOpts = {}) {
  if (!isWhatsAppIngestSessionKey(sessionKey)) {
    if (liveIngestSkipLogEnabled()) {
      console.log('[naboto-wa-live-ingest] skip_not_wa_session_key', sessionKey.slice(-56));
    }
    return;
  }

  const rawMsg = messageObjectFromEventPayload(payload);
  if (!rawMsg) {
    if (liveIngestSkipLogEnabled()) {
      console.log('[naboto-wa-live-ingest] skip_no_message_object', sessionKey.slice(-56));
    }
    return;
  }

  const body = buildWaLiveObservationBody(rawMsg, sessionKey, buildOpts);
  if (!body) {
    if (liveIngestSkipLogEnabled()) {
      const row = normalizeTranscriptRow(rawMsg);
      console.log(
        '[naboto-wa-live-ingest] skip_no_body',
        sessionKey.slice(-48),
        'role',
        row.role,
        'textLen',
        row.text.length,
        'fromPreview',
        Boolean(buildOpts.fromPreviewPolling),
      );
    }
    return;
  }

  const dk = `${sessionKey}|${body.detected_type}|${body.message_text.slice(0, 240)}`;
  if (dedupe.has(dk)) return;
  dedupe.add(dk);
  if (dedupe.size > 12000) dedupe.clear();

  const ins = await insertBotObservation(pool, body);
  if (!ins.ok) {
    console.warn('[naboto-wa-live-ingest] insert failed', ins.status, ins.json?.error || ins.json);
  } else if (process.env.NABOTO_WA_INGEST_LOG_INSERTS === '1') {
    console.log('[naboto-wa-live-ingest] inserted', ins.id, sessionKey.slice(-48));
  }
}

/**
 * OpenClaw WA plugin prepends synthetic context blocks to each message in the session transcript.
 * Strip these headers and return only the actual user message text.
 * @param {string} text
 * @returns {string}
 */
export function stripPreviewMetadataHeaders(text) {
  if (!text) return text;
  const BLOCK_RE = /^(?:[^\n]+ \(untrusted[^)]*\):\n```[^\n]*\n[\s\S]*?\n```\n\n)+/;
  return text.replace(BLOCK_RE, '');
}

/**
 * True when the preview row is only synthetic metadata (no user-visible text after stripping).
 * @param {object} item
 * @returns {boolean}
 */
export function isPreviewMetadataRow(item) {
  if (!item) return false;
  const text = previewItemRawText(item);
  if (!text) return false;
  const stripped = stripPreviewMetadataHeaders(text);
  return !stripped.trim();
}

/**
 * Ingest only preview rows that appeared since the last poll for this session (tail overlap diff).
 * @param {import('pg').Pool} pool
 * @param {string} sessionKey
 * @param {Set<string>} dedupe
 * @param {Map<string, string[]>} tailSigsByKey
 */
async function ingestPreviewItemsForSession(pool, sessionKey, items, dedupe, tailSigsByKey) {
  if (!isWhatsAppIngestSessionKey(sessionKey)) {
    if (liveIngestSkipLogEnabled()) {
      console.log('[naboto-wa-live-ingest] preview skip_not_wa_session_key', sessionKey.slice(-56));
    }
    return;
  }
  const prev = tailSigsByKey.get(sessionKey);
  const { newItems, nextSigs } = previewItemsNewSincePrevious(prev, items);
  tailSigsByKey.set(sessionKey, nextSigs);
  const debug = process.env.NABOTO_WA_LIVE_INGEST_DEBUG === '1';
  if (debug && newItems.length > 0) {
    console.log(
      '[naboto-wa-live-ingest] preview batch',
      sessionKey.slice(-40),
      'newItems:',
      newItems.length,
      'of',
      items.length,
    );
  }
  for (const item of newItems) {
    const isMeta = isPreviewMetadataRow(item);
    const raw = previewItemRawText(item);
    const stripped = stripPreviewMetadataHeaders(raw);
    if (debug) {
      console.log(
        '[naboto-wa-live-ingest] preview item role:',
        item.role,
        'isMeta:',
        isMeta,
        'stripped[:60]:',
        stripped.slice(0, 60).replace(/\n/g, '|'),
      );
    }
    if (isMeta) {
      if (liveIngestSkipLogEnabled()) {
        console.log(
          '[naboto-wa-live-ingest] skip_preview_metadata',
          sessionKey.slice(-40),
          'role',
          item?.role,
        );
      }
      continue;
    }
    const rawMsg = { role: item.role, content: stripped || raw };
    await maybeIngestSessionMessage(pool, sessionKey, { message: rawMsg }, dedupe, {
      fromPreviewPolling: true,
    });
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {(method: string, params?: object, timeoutMs?: number) => Promise<unknown>} rpc
 * @param {Iterable<string>} subscribedKeys
 * @param {Set<string>} dedupe
 * @param {Map<string, string[]>} tailSigsByKey
 */
async function pollSessionsPreviewForWhatsapp(pool, rpc, subscribedKeys, dedupe, tailSigsByKey) {
  const keys = [...subscribedKeys].filter(isWhatsAppIngestSessionKey);
  if (keys.length === 0) return;
  const limit = previewRpcLimit();
  const maxChars = previewRpcMaxChars();
  for (let i = 0; i < keys.length; i += 64) {
    const chunk = keys.slice(i, i + 64);
    let res;
    try {
      res = await rpc('sessions.preview', { keys: chunk, limit, maxChars }, 30_000);
    } catch (e) {
      console.warn('[naboto-wa-live-ingest] sessions.preview failed', e.message);
      continue;
    }
    const previews = res && typeof res === 'object' ? res.previews : null;
    if (!Array.isArray(previews)) continue;
    for (const pr of previews) {
      const key = typeof pr.key === 'string' ? pr.key : null;
      if (!key || pr.status === 'missing' || pr.status === 'error') continue;
      const items = pr.items;
      if (!Array.isArray(items) || items.length === 0) continue;
      try {
        await ingestPreviewItemsForSession(pool, key, items, dedupe, tailSigsByKey);
      } catch (e) {
        console.warn('[naboto-wa-live-ingest] preview ingest', key, e.message);
      }
    }
  }
}

/**
 * @param {(method: string, params: object) => Promise<unknown>} rpc
 * @param {Set<string>} subscribed
 */
async function subscribeAllWhatsappSessions(rpc, subscribed) {
  let listPayload;
  try {
    listPayload = await rpc('sessions.list', {}, 20000);
  } catch (e) {
    console.error('[naboto-wa-live-ingest] sessions.list failed', e.message);
    return;
  }

  const keys = sessionKeysFromListPayload(listPayload);
  for (const key of keys) {
    if (!isWhatsAppIngestSessionKey(key)) continue;
    if (subscribed.has(key)) continue;
    try {
      await rpc('sessions.messages.subscribe', { key }, 12000);
      subscribed.add(key);
    } catch (e2) {
      console.warn('[naboto-wa-live-ingest] sessions.messages.subscribe failed for', key, e2.message);
    }
  }
}

/**
 * @param {(method: string, params?: object, timeoutMs?: number) => Promise<unknown>} rpc
 */
async function bootstrapSubscriptions(rpc) {
  try {
    await rpc('sessions.subscribe', {}, 12000);
  } catch (e) {
    console.warn('[naboto-wa-live-ingest] sessions.subscribe optional failed', e.message);
  }
  const subscribed = new Set();
  await subscribeAllWhatsappSessions(rpc, subscribed);
  return subscribed;
}

/**
 * Run one gateway WS connection until close/error.
 * @param {import('pg').Pool} pool
 */
function runOneConnection(pool) {
  return new Promise((resolve) => {
    const token = getGatewayToken();
    const refreshMs = sessionRefreshIntervalMs();
    const previewPollMs = previewPollIntervalMs();
    const wsUrl = `ws://127.0.0.1:${INTERNAL}`;
    const dedupe = new Set();
    const subscribedKeys = new Set();
    /** Last `sessions.preview` tail signatures per session (overlap diff). */
    const previewTailSigsByKey = new Map();
    /** @type {ReturnType<typeof setInterval> | null} */
    let sessionRefreshTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let previewPollTimer = null;

    /** Connect uses id "1"; RPC ids must start at 2 to avoid collision. */
    let reqCounter = 1;
    /** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
    const pending = new Map();

    const ws = new WebSocket(wsUrl, {
      headers: { Origin: `http://127.0.0.1:${INTERNAL}` },
    });
    wsRef = ws;

    function cleanupPending(err) {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    }

    function rpc(method, params = {}, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        reqCounter += 1;
        const id = String(reqCounter);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`rpc timeout ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(e);
        }
      });
    }

    ws.on('open', () => {});

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        ws.send(
          JSON.stringify({
            type: 'req',
            id: '1',
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: 'openclaw-control-ui',
                version: 'naboto-live-ingest',
                platform: 'node',
                mode: 'webchat',
              },
              role: 'operator',
              scopes: ['operator.admin', 'operator.read'],
              auth: { token },
              caps: [],
            },
          }),
        );
        return;
      }

      if (msg.type === 'event' && msg.event === 'session.message') {
        const pl = msg.payload;
        const sk =
          sessionKeyFromEventPayload(pl) ||
          (pl && typeof pl === 'object' && pl.message && typeof pl.message === 'object'
            ? sessionKeyFromEventPayload(pl.message)
            : null) ||
          sessionKeyFromEventPayload(msg);
        if (sk) {
          maybeIngestSessionMessage(pool, sk, msg.payload, dedupe).catch((e) =>
            console.error('[naboto-wa-live-ingest] ingest async', e.message),
          );
        } else if (process.env.NABOTO_WA_LIVE_INGEST_DEBUG === '1' && pl && typeof pl === 'object') {
          console.warn(
            '[naboto-wa-live-ingest] session.message sin session key (payload keys:',
            Object.keys(pl).join(','),
            ')',
          );
        }
        return;
      }

      if (msg.type === 'event' && msg.event === 'sessions.changed') {
        subscribeAllWhatsappSessions(rpc, subscribedKeys).catch((e) =>
          console.warn('[naboto-wa-live-ingest] refresh subs', e.message),
        );
        return;
      }

      if (msg.type !== 'res') return;

      const rid = String(msg.id);
      const waiter = pending.get(rid);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(rid);
        if (msg.ok === false) {
          const errText = msg.error?.message || msg.payload?.message || 'rpc error';
          waiter.reject(new Error(errText));
        } else {
          waiter.resolve(msg.payload ?? msg.result);
        }
      }

      if (rid === '1' && msg.ok === true) {
        bootstrapSubscriptions(rpc)
          .then((subs) => {
            subs.forEach((k) => subscribedKeys.add(k));
            console.log('[naboto-wa-live-ingest] subscribed WA sessions:', subscribedKeys.size);
            if (refreshMs > 0) {
              sessionRefreshTimer = setInterval(() => {
                const before = subscribedKeys.size;
                subscribeAllWhatsappSessions(rpc, subscribedKeys)
                  .then(() => {
                    if (subscribedKeys.size !== before) {
                      console.log(
                        '[naboto-wa-live-ingest] WA session subscriptions:',
                        subscribedKeys.size,
                        '(was',
                        String(before) + ')',
                      );
                    }
                  })
                  .catch((e) =>
                    console.warn('[naboto-wa-live-ingest] periodic sessions refresh', e.message),
                  );
              }, refreshMs);
            }
            if (previewPollMs > 0) {
              const runPreview = () =>
                pollSessionsPreviewForWhatsapp(pool, rpc, subscribedKeys, dedupe, previewTailSigsByKey).catch(
                  (e) => console.warn('[naboto-wa-live-ingest] preview poll', e.message),
                );
              setTimeout(runPreview, 2500);
              previewPollTimer = setInterval(runPreview, previewPollMs);
              console.log(
                '[naboto-wa-live-ingest] sessions.preview poll every',
                previewPollMs,
                'ms (limit',
                previewRpcLimit(),
                'maxChars',
                previewRpcMaxChars() + ')',
              );
            }
          })
          .catch((e) => console.error('[naboto-wa-live-ingest] bootstrap failed', e.message));
      }
    });

    ws.on('error', (e) => {
      console.warn('[naboto-wa-live-ingest] ws error', e.message);
    });

    ws.on('close', () => {
      if (sessionRefreshTimer) {
        clearInterval(sessionRefreshTimer);
        sessionRefreshTimer = null;
      }
      if (previewPollTimer) {
        clearInterval(previewPollTimer);
        previewPollTimer = null;
      }
      previewTailSigsByKey.clear();
      cleanupPending(new Error('ws closed'));
      wsRef = null;
      resolve();
    });
  });
}

let ingestLoopRunning = false;

/**
 * Start background loop: connect, run, reconnect with backoff.
 */
export function startNabotoWaLiveIngest() {
  if (!waLiveIngestEnabled()) {
    console.log('[naboto-wa-live-ingest] disabled (no DATABASE_URL or NABOTO_WA_LIVE_INGEST=0)');
    return;
  }
  if (ingestLoopRunning) return;
  ingestLoopRunning = true;
  stopRequested = false;

  (async function loop() {
    let delay = 3000;
    while (!stopRequested) {
      const pool = getNabotoPool();
      if (!pool) break;
      try {
        await runOneConnection(pool);
      } catch (e) {
        console.warn('[naboto-wa-live-ingest] connection ended', e.message);
      }
      if (stopRequested) break;
      await new Promise((r) => {
        reconnectTimer = setTimeout(r, delay);
      });
      reconnectTimer = null;
      delay = Math.min(delay * 1.5, 60000);
    }
    ingestLoopRunning = false;
  })();
}

export function stopNabotoWaLiveIngest() {
  stopRequested = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    wsRef?.close();
  } catch {}
  wsRef = null;
}
