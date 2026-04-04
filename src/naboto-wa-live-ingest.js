/**
 * NaBoTo — persist WhatsApp transcript rows to bot_observations in near real time.
 * Subscribes to gateway WebSocket `session.message` events (no LLM).
 *
 * Disable: NABOTO_WA_LIVE_INGEST=0
 */

import WebSocket from 'ws';
import { getGatewayToken } from './gateway.js';
import { getNabotoPool } from './naboto-pool.js';
import { insertBotObservation } from './naboto-observations.js';

const INTERNAL = process.env.INTERNAL_GATEWAY_PORT || '18789';

/** @returns {boolean} */
export function waLiveIngestEnabled() {
  const v = process.env.NABOTO_WA_LIVE_INGEST;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return Boolean(getNabotoPool());
}

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isWhatsAppIngestSessionKey(key) {
  if (typeof key !== 'string') return false;
  if (!key.includes('whatsapp')) return false;
  if (key.includes(':cron:')) return false;
  return key.includes('group:') || key.includes(':direct:');
}

/**
 * @param {string} sessionKey
 * @returns {string}
 */
export function sourceGroupFromSessionKey(sessionKey) {
  const g = sessionKey.match(/group:([^\s]+)$/);
  if (g) return g[1].slice(0, 500);
  const d = sessionKey.match(/direct:([^\s]+)$/);
  if (d) return d[1].slice(0, 500);
  return sessionKey.slice(0, 500);
}

/**
 * @param {string} sessionKey
 * @returns {string}
 */
export function detectedTypeForSessionKey(sessionKey) {
  if (sessionKey.includes('group:')) return 'wa_live_group';
  if (sessionKey.includes(':direct:')) return 'wa_live_dm';
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
 */
async function maybeIngestSessionMessage(pool, sessionKey, payload, dedupe) {
  if (!isWhatsAppIngestSessionKey(sessionKey)) return;

  const rawMsg = messageObjectFromEventPayload(payload);
  if (!rawMsg) return;

  const { role, text, author, id } = normalizeTranscriptRow(rawMsg);
  if (!text) return;
  if (role === 'assistant' || role === 'tool' || role === 'system') return;

  const dk = `${sessionKey}|${id}|${text.slice(0, 240)}`;
  if (dedupe.has(dk)) return;
  dedupe.add(dk);
  if (dedupe.size > 12000) dedupe.clear();

  const ins = await insertBotObservation(pool, {
    source_group: sourceGroupFromSessionKey(sessionKey),
    message_author: author,
    message_text: text,
    detected_type: detectedTypeForSessionKey(sessionKey),
  });
  if (!ins.ok) {
    console.warn('[naboto-wa-live-ingest] insert failed', ins.status, ins.json?.error || ins.json);
  }
}

/**
 * @param {(method: string, params: object) => Promise<unknown>} rpc
 * @param {Set<string>} subscribed
 */
async function subscribeAllWhatsappSessions(rpc, subscribed) {
  let listPayload;
  try {
    listPayload = await rpc('sessions.list', { allAgents: true }, 20000);
  } catch {
    try {
      listPayload = await rpc('sessions.list', {}, 20000);
    } catch (e) {
      console.error('[naboto-wa-live-ingest] sessions.list failed', e.message);
      return;
    }
  }

  const keys = sessionKeysFromListPayload(listPayload);
  for (const key of keys) {
    if (!isWhatsAppIngestSessionKey(key)) continue;
    if (subscribed.has(key)) continue;
    try {
      await rpc('sessions.messages.subscribe', { sessionKey: key }, 12000);
      subscribed.add(key);
    } catch {
      try {
        await rpc('sessions.messages.subscribe', { key }, 12000);
        subscribed.add(key);
      } catch (e2) {
        console.warn('[naboto-wa-live-ingest] sessions.messages.subscribe failed for', key, e2.message);
      }
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
    const token = getToken();
    const wsUrl = `ws://127.0.0.1:${INTERNAL}`;
    const dedupe = new Set();
    const subscribedKeys = new Set();

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
          (pl && typeof pl === 'object' ? sessionKeyFromEventPayload(pl.message) : null);
        if (sk) {
          maybeIngestSessionMessage(pool, sk, msg.payload, dedupe).catch((e) =>
            console.error('[naboto-wa-live-ingest] ingest async', e.message),
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
          })
          .catch((e) => console.error('[naboto-wa-live-ingest] bootstrap failed', e.message));
      }
    });

    ws.on('error', (e) => {
      console.warn('[naboto-wa-live-ingest] ws error', e.message);
    });

    ws.on('close', () => {
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
