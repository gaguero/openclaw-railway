---
name: naboto-wa-ingest
description: Use when the user wants to parse a WhatsApp "WA GROUPS" text export, dry-run bulk ingest, or load historical messages into bot_observations from the server-side JSONL (same gateway Bearer as queries). For JSONL dry-run from chat, prefer GET wa-jsonl-ingest?source=preview (OpenClaw exec often maps curl to HTTP GET without POST body). Wrapper HTTP is usually 127.0.0.1:8080 inside the container. Spanish summaries for the user.
---

# Ingesta histórica WA → `bot_observations` (UI / conversación)

El usuario puede pedirte **en el chat** cosas como: *«simulá la ingesta del JSONL»*, *«parseá este export»*, *«cargá el preview al Postgres»*. Vos tenés que usar la herramienta **`exec`** con **`curl`** real (igual que **naboto-query-context**).

### Regla crítica para `exec` / fetch del Control UI

1. **URL sin variables de bash:** OpenClaw suele ejecutar un **fetch** que **no pasa por bash**, así que la cadena `${NABOTO_WRAPPER_PORT:-8080}` puede quedar **literal** en la URL y fallar o comportarse mal. En **todos** los comandos de esta skill, usá **`http://127.0.0.1:8080`** (número fijo) en la URL, no `${...}`.
2. **Después del resultado:** leé el JSON de stdout **una vez**. Respondé al usuario en **≤6 viñetas** (p. ej. `dry_run`, `inserted`, `total_lines`, `json_ok`, `skipped_empty`, `errors`). **Prohibido** repetir la misma frase decenas de veces o alucinar cifras que no estén en el JSON.

## Auth y URL base

- Header: `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN` (mismo token que consultas NaBoTo).
- **Host/puerto del wrapper HTTP:** `http://127.0.0.1:8080` (fijo en `exec`; coincide con `PORT` en Railway salvo override raro).
- **No** confundas con el WebSocket del gateway (**18789**): las rutas admin NaBoTo van al **wrapper HTTP**, no al WS.

### OpenClaw `exec` y “fetch”

En los logs del gateway a veces verás que `exec` ejecuta un **fetch GET** en lugar de un POST con `-d`. Si el dry-run con POST falla o el body no llega, usá **GET** (más abajo): el servidor trata GET como **dry-run obligatorio** (nunca inserta filas).

## 1) Descubrir rutas admin (opcional)

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:8080/api/naboto/query"
```

En la respuesta JSON mirá el objeto **`admin_wa`** (endpoints y cuerpos).

## 2) Parsear un export `.txt` (sin escribir DB)

**POST** `Content-Type: application/json`. El cuerpo puede ser grande (hasta ~3MB).

Guardá el texto del export en un archivo en el contenedor (por ejemplo el usuario lo pega en el chat y vos lo escribís con `exec` / redirección según las herramientas disponibles), luego generá el JSON con **Node** y enviálo con `curl`:

```bash
node -e "const fs=require('fs');const t=fs.readFileSync('/tmp/wa_export.txt','utf8');process.stdout.write(JSON.stringify({text:t}));" \
  | curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d @- \
  "http://127.0.0.1:8080/api/naboto/admin/wa-parse"
```

Si el export es **enorme** (> ~2MB) o no cabe en un mensaje, pedí que lo procesen por CLI local o que redeployen el JSONL y usen solo **wa-jsonl-ingest**.

Respuesta útil: `sections`, `records`, `sample` (filas ejemplo). Explicá en **español** qué significa (cuántas secciones, cuántos mensajes parseados).

## 3) Ingesta masiva desde JSONL en el servidor (`preview`)

El archivo **`scripts/fixtures/_parsed-preview.jsonl`** va **dentro de la imagen Docker** si está en el repo al hacer build. Así el usuario puede decir *«dry-run del preview»* sin pegar el JSONL.

**Dry-run (preferido en el chat — GET, sin body):**

```bash
curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  "http://127.0.0.1:8080/api/naboto/admin/wa-jsonl-ingest?source=preview&limit=5000"
```

- **`source=preview`** (minúsculas; alias: `default`, `jsonl`, `parsed-preview` vía normalización en POST; en query usá `preview`).
- GET **siempre** es simulación (no escribe en la DB).

**Dry-run vía POST** (si tu `exec` sí respeta `-d` y `Content-Type: application/json`):

```bash
curl -sS -X POST -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"preview","dry_run":true,"limit":5000}' \
  "http://127.0.0.1:8080/api/naboto/admin/wa-jsonl-ingest"
```

**Ingesta real** (solo **POST**; **irreversible** salvo limpieza manual en DB):

```bash
curl -sS -X POST -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"preview","dry_run":false,"limit":100}' \
  "http://127.0.0.1:8080/api/naboto/admin/wa-jsonl-ingest"
```

- Pedí confirmación explícita antes de `dry_run:false` con `limit` alto.
- Empezá con **`limit` pequeño** (p. ej. 10–50) y verificá con **GET** `.../api/naboto/query/observations` (skill **naboto-query-context**).

## Reglas

1. **No inventar** conteos ni IDs: salen del JSON del `curl`.
2. **PII:** el contenido es operativo sensible; en grupos públicos resumí; en DM con Gerson podés ser más explícito si pide detalle.
3. **Prohibido** pegar el gateway token en mensajes al usuario.
4. Si el archivo no está en la imagen (`404` / `file not found`), explicá que hace falta **redeploy** con el fixture en el repo o añadir otro `source` en código.
5. **No** uses GET sobre `/api/naboto/admin/wa-parse?dry_run=...` — ese endpoint es **solo POST** con JSON; GET devuelve 405 con pista para usar `wa-jsonl-ingest`.

## Relación con POST `/api/naboto/observations`

La ingesta **unitaria** externa sigue siendo `NABOTO_INGEST_SECRET`. Estos endpoints **admin** usan **solo** `OPENCLAW_GATEWAY_TOKEN` y están pensados para el **agente dentro del mismo contenedor**.
