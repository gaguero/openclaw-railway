---
name: naboto-query-context
description: Use when the user asks about recent operational messages (bot_observations), Opera sync status (opera_sync_log), arrivals (Postgres), or AppSheet Concierge tables (allowlisted read-only Find). Same auth: curl + OPENCLAW_GATEWAY_TOKEN. Do not use for "who are you" or agent identity — that is SOUL.md / NaBoTo the assistant, not this feed.
---

# Feed de observaciones operativas (Postgres)

**Obligatorio antes de decir “no tengo acceso”:** si la pregunta es **llegadas hoy**, **reservas con arribo hoy**, **quién llega hoy** o similar → **ejecutá `curl`** al endpoint **arrivals** con `from_day=0` y `to_day=0` (y `limit` razonable) usando `OPENCLAW_GATEWAY_TOKEN`, **luego** interpretá el JSON. No derives a OPERATOR/OPERA sin ese paso.

## Invocación real del shell (no pseudocódigo)

- Tenés que usar la herramienta nativa de **shell del gateway** (en OpenClaw suele llamarse **`exec`**; llamada a herramienta / tool use del asistente), con **un comando shell** (por ejemplo la línea `curl` de abajo). El proceso corre en el mismo contenedor que el wrapper. Usá **`NABOTO_WRAPPER_PORT`** en la URL (inyectada por config de skill; fallback **8080**); **`OPENCLAW_GATEWAY_TOKEN`** debe estar disponible para `curl`.
- **Prohibido** poner en el mensaje del asistente: `tool_code`, `print(`, Python, `exec.run_shell`, `run_shell`, ni ningún código que *simule* una herramienta. Eso **no ejecuta nada** y el usuario no ve el JSON.
- Flujo correcto: (1) tool **`exec`** → comando = `curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" "http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}/api/naboto/query/arrivals?from_day=0&to_day=0&limit=50"` (2) leer stdout (3) responder en **español** con el resumen. **No** uses solo `$PORT` en `exec`: en el sandbox del agente a veces no existe; esta imagen define **`NABOTO_WRAPPER_PORT`** (skill `env` + proceso gateway).

## Prohibido inventar reservas o volcar JSON falso

- **Nunca** armés en el mensaje del asistente un bloque de código con JSON (p. ej. cercano a *json* en markdown) ni JSON suelto con huéspedes, habitaciones, fechas o estados **si no salieron exactamente de stdout del `curl`** en ese turno. Ejemplos como *«María García», «Suite Presidencial»* inventados son **grave**: podés perjudicar operación y confianza.
- Si **no** llamaste a **`exec`** y no tenés el cuerpo HTTP real, **no listes llegadas**: decí que tenés que ejecutar el `curl` primero o que no consta.
- Al usuario respondé en **prosa en español** (viene X llegada, Y habitación según API). No hace falta pegar el JSON completo salvo que lo pidan; **nunca** simules respuesta de API.

**No confundir:** vos sos el agente **NaBoTo** (persona, hotel). Esta skill describe solo cómo responder cuando preguntan por **mensajes operativos ya guardados** en `bot_observations` / vista `v_naboto_observations_recent`. Si el usuario pregunta **quién sos** o **“como NaBoTo”** en sentido personal, respondé según **SOUL.md**, no expliques esta vista como si “NaBoTo fuera una herramienta”.

## Cuándo usar

- Preguntas sobre lo dicho recientemente en grupos operativos **si** esos mensajes se guardaron en `bot_observations`.
- “Qué se reportó hoy”, “últimos avisos de X grupo” (si hay datos ingeridos).

## API de consulta (misma instancia OpenClaw / Railway)

Autenticación en **cada** request:

`Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN`

Base URL (proceso **wrapper** `server.js` en el mismo contenedor, no el WS del gateway): `http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}`. OpenClaw inyecta **`NABOTO_WRAPPER_PORT`** vía `skills.entries` (Railway: suele ser `8080`). Evitá confundir con el puerto interno del gateway (**18789**).

### Descubrir endpoints

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" "http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}/api/naboto/query"
```

### Observaciones ingeridas (`bot_observations`)

- `limit` 1–40 (default 15), `hours` 1–168 (default 72)
- `q` — texto opcional (búsqueda en `message_text`)
- `group` — fragmento opcional de `source_group`

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}/api/naboto/query/observations?limit=12&hours=48"

curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}/api/naboto/query/observations?group=Guest&hours=24"
```

### Últimas corridas Opera → NBDT (`opera_sync_log`)

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}/api/naboto/query/opera-sync?limit=5"
```

### Llegadas / reservas en ventana de fechas (`reservations` + huésped si existe join)

Días relativos a **hoy** (`CURRENT_DATE + from_day` … `CURRENT_DATE + to_day`). Defaults: `from_day=-1`, `to_day=14`.

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}/api/naboto/query/arrivals?from_day=0&to_day=7&limit=30"
```

**Solo llegadas con fecha de hoy** (`from_day` y `to_day` = 0 respecto a `CURRENT_DATE`):

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}/api/naboto/query/arrivals?from_day=0&to_day=0&limit=50"
```

Si la respuesta trae `ok:false`, no inventes datos: comunicá el error o pedí verificación a OPERATOR/ADMIN.

**Lite (humans):** sigue disponible `GET /lite/api/naboto/summary` con cookie de setup.

---

## AppSheet Concierge (solo lectura)

**Política:** lectura permitida solo sobre tablas listadas en `APPSHEET_READONLY_TABLES` (Railway). **Prohibido** pedir writes o asumir que el bot puede editar AppSheet (ver `appsheet_gate_policy.md` en memoria).

### Estado y tablas permitidas

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}/api/naboto/appsheet"
```

### Filas de una tabla (Find + límite server-side)

El nombre en la URL debe coincidir **exactamente** con un nombre de la allowlist (como en **Data → Tables** en AppSheet). `limit` 1–100 (default 25).

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:${NABOTO_WRAPPER_PORT:-8080}/api/naboto/appsheet/find/MiTabla?limit=20"
```

Si `configured:false` o tabla no allowlisted, explicá que falta configuración o el nombre no está habilitado — no inventes filas.

**PII / tarifas:** mismos guardrails que Postgres; en grupos WA, resumir y evitar datos sensibles.

---

## Reglas

1. **Solo lectura.** Postgres y AppSheet: estos endpoints no escriben.
2. Usá la herramienta **`exec`** (invocación real) para `curl`, como en **searxng-local** — nunca pseudocódigo; no pegues el token en grupos de WhatsApp.
3. **No inventar** filas; si `count` es 0 o `ok:false`, decilo claro.
4. Aplicar **guardrails** de PII (ver `guardrails_permissions_matrix.md` en el proyecto memoria).
5. **Cero alucinación de filas:** si no hay stdout de `curl`, no hay datos de llegadas para contar.

## Formato de respuesta

- Resumir por `source_group` y tiempo.
- Citas cortas; no volcar textos enormes sin que el usuario lo pida.
