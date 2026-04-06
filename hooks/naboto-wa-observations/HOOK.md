---
name: naboto-wa-observations
description: Persist WhatsApp inbound messages (post-preprocess) to NaBoTo Postgres via wrapper HTTP ingest.
metadata:
  openclaw:
    emoji: "🗃️"
    events:
      - "message:preprocessed"
---

# NaBoTo — WhatsApp → `bot_observations` (hook)

Runs on **`message:preprocessed`** inside the OpenClaw gateway (after media/link enrichment). Posts JSON to the Railway wrapper:

`POST http://127.0.0.1:${NABOTO_WRAPPER_PORT:-$PORT}/api/naboto/observations` with `Authorization: Bearer $NABOTO_INGEST_SECRET` (el handler usa `NABOTO_WRAPPER_PORT` primero, igual que el spawn del gateway en `gateway.js`).

## Env (Railway)

| Variable | Effect |
|----------|--------|
| `NABOTO_INGEST_SECRET` | Required for HTTP ingest |
| `DATABASE_URL` | Wrapper enables pool; hook is configured when both are set |
| `NABOTO_WA_HOOK_INGEST=0` | Disables this hook in `openclaw.json` merge |
| `NABOTO_WA_HOOK_GROUP_ALLOWLIST=1` | Only groups whose JID is in `NABOTO_WA_ALLOWLIST_GROUP_JIDS` (+ hotel premerge list) |
| `NABOTO_WA_HOOK_INGEST_DMS=0` | Skip WhatsApp DMs |
| `NABOTO_WA_HOOK_DM_ALLOWLIST` | Comma-separated E.164-ish numbers; if set, only those senders for DMs |

Works alongside **`naboto-wa-live-ingest.js`** (WS + `sessions.preview` fallback); dedupe at DB layer is best-effort via `messageId` when present.
