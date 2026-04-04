---
name: naboto_query_context
description: Use when the user asks about recent operational messages (bot_observations), Opera sync status (opera_sync_log), arrivals (Postgres), or AppSheet Concierge tables (allowlisted read-only Find). Same auth: curl + OPENCLAW_GATEWAY_TOKEN. Do not use for "who are you" or agent identity — that is SOUL.md / NaBoTo the assistant, not this feed.
---

# Feed de observaciones operativas (Postgres)

**No confundir:** vos sos el agente **NaBoTo** (persona, hotel). Esta skill describe solo cómo responder cuando preguntan por **mensajes operativos ya guardados** en `bot_observations` / vista `v_naboto_observations_recent`. Si el usuario pregunta **quién sos** o **“como NaBoTo”** en sentido personal, respondé según **SOUL.md**, no expliques esta vista como si “NaBoTo fuera una herramienta”.

## Cuándo usar

- Preguntas sobre lo dicho recientemente en grupos operativos **si** esos mensajes se guardaron en `bot_observations`.
- “Qué se reportó hoy”, “últimos avisos de X grupo” (si hay datos ingeridos).

## API de consulta (misma instancia OpenClaw / Railway)

Autenticación en **cada** request:

`Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN`

Base URL (proceso wrapper en el mismo contenedor): `http://127.0.0.1:${PORT}` — en Railway, `PORT` suele estar definido (si falla, probá `8080`).

### Descubrir endpoints

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" "http://127.0.0.1:${PORT}/api/naboto/query"
```

### Observaciones ingeridas (`bot_observations`)

- `limit` 1–40 (default 15), `hours` 1–168 (default 72)
- `q` — texto opcional (búsqueda en `message_text`)
- `group` — fragmento opcional de `source_group`

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${PORT}/api/naboto/query/observations?limit=12&hours=48"

curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${PORT}/api/naboto/query/observations?group=Guest&hours=24"
```

### Últimas corridas Opera → NBDT (`opera_sync_log`)

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${PORT}/api/naboto/query/opera-sync?limit=5"
```

### Llegadas / reservas en ventana de fechas (`reservations` + huésped si existe join)

Días relativos a **hoy** (`CURRENT_DATE + from_day` … `CURRENT_DATE + to_day`). Defaults: `from_day=-1`, `to_day=14`.

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${PORT}/api/naboto/query/arrivals?from_day=0&to_day=7&limit=30"
```

Si la respuesta trae `ok:false`, no inventes datos: comunicá el error o pedí verificación a OPERATOR/ADMIN.

**Lite (humans):** sigue disponible `GET /lite/api/naboto/summary` con cookie de setup.

---

## AppSheet Concierge (solo lectura)

**Política:** lectura permitida solo sobre tablas listadas en `APPSHEET_READONLY_TABLES` (Railway). **Prohibido** pedir writes o asumir que el bot puede editar AppSheet (ver `appsheet_gate_policy.md` en memoria).

### Estado y tablas permitidas

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${PORT}/api/naboto/appsheet"
```

### Filas de una tabla (Find + límite server-side)

El nombre en la URL debe coincidir **exactamente** con un nombre de la allowlist (como en **Data → Tables** en AppSheet). `limit` 1–100 (default 25).

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${PORT}/api/naboto/appsheet/find/MiTabla?limit=20"
```

Si `configured:false` o tabla no allowlisted, explicá que falta configuración o el nombre no está habilitado — no inventes filas.

**PII / tarifas:** mismos guardrails que Postgres; en grupos WA, resumir y evitar datos sensibles.

---

## Reglas

1. **Solo lectura.** Postgres y AppSheet: estos endpoints no escriben.
2. Usá **exec** / shell para `curl` como en **searxng-local**; no pegues el token en grupos de WhatsApp.
3. **No inventar** filas; si `count` es 0 o `ok:false`, decilo claro.
4. Aplicar **guardrails** de PII (ver `guardrails_permissions_matrix.md` en el proyecto memoria).

## Formato de respuesta

- Resumir por `source_group` y tiempo.
- Citas cortas; no volcar textos enormes sin que el usuario lo pida.
