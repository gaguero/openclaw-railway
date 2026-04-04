# Consolidación NaBoTo en OpenClaw (Railway)

## Qué queda después de consolidar

- **Identidad** en config: nombre *NaBoTo*, emoji 🏨 — el **wrapper** aplica `ensureNabotoAgentIdentity` en cada arranque del gateway: si el agente por defecto no tiene nombre o tiene un nombre genérico (`OpenClaw`, `Assistant`, etc.), se escribe NaBoTo en `openclaw.json`. Un nombre **personalizado** no se pisa.
- **Personalidad y reglas** en `SOUL.md` del workspace (inyectado al contexto del agente).
- **Skill** `naboto-query-context` disponible desde `/bundled-skills` (vía `skills.load.extraDirs`). El arranque del wrapper escribe `skills.entries['naboto-query-context'].env.NABOTO_WRAPPER_PORT` (= `PORT` de Railway, típ. **8080**) para que `exec` + `curl` no dependan de `$PORT` en el sandbox.
- **Chat web** en `/openclaw` habla con el mismo agente; **WhatsApp** es opcional y se añade después con `channels.whatsapp`.

## Paso 1 — `SOUL.md` en el workspace

En el **primer arranque** del contenedor con volumen vacío, el `entrypoint` copia `docs/naboto/SOUL.md` → `/data/workspace/SOUL.md` si aún no existe.

Si ya tenías workspace sin SOUL: copiá manualmente (terminal web Railway / Lite):

```bash
cp /app/docs/naboto/SOUL.md "$OPENCLAW_WORKSPACE_DIR/SOUL.md"
# típicamente OPENCLAW_WORKSPACE_DIR=/data/workspace
```

Si **ya existe** `SOUL.md` viejo (el bot dice “no tengo acceso” sin hacer `curl`): fusioná a mano la sección **«Reservas, llegadas hoy…»** desde `/app/docs/naboto/SOUL.md`, o reemplazá el archivo una vez (backup antes) con `cp /app/docs/naboto/SOUL.md "$OPENCLAW_WORKSPACE_DIR/SOUL.md"`.

Reiniciá el **gateway** tras cambiar SOUL.

## Paso 2 — Fusionar `openclaw.json`

1. Abrí **Lite** → API de config o descargá `openclaw.json` desde backup/export.
2. Abrí `docs/naboto/openclaw.fragment.json5` como referencia.
3. **Importante:** si ya tenés `agents.list` con más de un agente o campos distintos, **no** pegues el array completo encima: solo añadí/mergeá:
   - `skills.load.extraDirs` → `["/bundled-skills"]`
   - en el agente `main` (o el default): bloque `identity` con `name`, `theme`, `emoji`
   - **No** uses `agents.defaults.skills` en esta imagen (OpenClaw lo rechaza). La skill se activa con `skills.entries.naboto-query-context` (lo hace el arranque). Si algún agente en `agents.list` tiene `skills: [...]` explícito, añadí ahí `naboto-query-context` o dejá que el wrapper lo mergee al reiniciar.
4. Validá JSON y reiniciá gateway.

## Paso 3 — Skill en workspace (alternativa)

Si no querés `extraDirs`, copiá la carpeta del skill al workspace:

```bash
mkdir -p /data/workspace/skills
cp -r /bundled-skills/naboto-query-context /data/workspace/skills/
```

## Si el chat falla con `Provider finish_reason: error`

Eso viene del **proveedor LLM** (p. ej. OpenRouter), no de Naboto. El modelo meta **`openrouter/openrouter/auto`** suele ser inestable. En esta imagen, el arranque del wrapper **reemplaza** ese valor por un modelo fijo (`openrouter/openai/gpt-4o-mini` por defecto) salvo que pongas **`OPENCLAW_KEEP_OPENROUTER_AUTO=1`**. Para elegir otro modelo: variable **`OPENROUTER_PRIMARY_MODEL`** (id completo tipo `openrouter/anthropic/claude-3.5-sonnet`). Revisá también que la **API key** de OpenRouter esté bien en Railway.

## Paso 4 — Verificación

1. Chat en `/openclaw`: el agente debe presentarse acorde a **NaBoTo** y seguir reglas de SOUL.
2. `GET /lite/api/naboto/summary` (logueado): observaciones recientes en DB.
3. **Consultas para el agente:** `GET /api/naboto/query` con header `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN` (mismo token que el proxy). Probar desde SSH del contenedor: `curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" "http://127.0.0.1:${PORT}/api/naboto/query"`.
4. **AppSheet (opcional):** con `APPSHEET_*` configuradas, `GET /api/naboto/appsheet` y `GET /api/naboto/appsheet/find/NombreTabla?limit=10`.

## WhatsApp — Setup

El wrapper inyecta config base de WhatsApp al arrancar (`ensureWhatsAppBaseline` en `gateway.js`). Solo se aplica si `channels.whatsapp.enabled` ya es `true` en `openclaw.json`.

### Fase 1: Observador silencioso (testing con teléfono personal)

1. **Instalar plugin** (una vez, desde terminal del contenedor):
   ```bash
   openclaw plugins install @openclaw/whatsapp
   ```

2. **Habilitar el canal** (si no existe aún en config):
   ```bash
   openclaw config set channels.whatsapp.enabled true
   ```
   El wrapper llena los defaults al próximo reinicio: `dmPolicy: "disabled"`, `groupPolicy: "allowlist"`, `groups: {}` (**objeto**, no array; vacío = ningún grupo permitido hasta que agregues JIDs), `historyLimit: 500`, `sendReadReceipts: false`, `reactionLevel: "off"`.

3. **QR link** con el teléfono personal:
   ```bash
   openclaw channels login --channel whatsapp
   ```
   Escanear el QR con WhatsApp.

4. **Allowlist de grupos** — OpenClaw exige `channels.whatsapp.groups` como **registro** (clave = JID del grupo, valor = opciones). Ejemplo en `openclaw.json` (Lite → config o edición del archivo):
   ```json
   "groups": {
     "120363012345678901@g.us": { "requireMention": true }
   }
   ```
   Descubrí el JID en logs del gateway o con `openclaw channels status` / documentación del plugin.

5. **Persistencia a Postgres (cron)** — los jobs **no** van dentro de `openclaw.json`; OpenClaw los guarda en `~/.openclaw/cron/jobs.json`. **Importante:** `POST /api/naboto/observations` usa el Bearer **`NABOTO_INGEST_SECRET`** (variable de Railway), **no** `OPENCLAW_GATEWAY_TOKEN`.

   Creá el job una vez (comillas simples en `--message` para que `$NABOTO_INGEST_SECRET` no se expanda en tu shell al pegar; el agente dentro del contenedor sí la resuelve en `exec`):
   ```bash
   openclaw cron add \
     --name "wa-group-persist" \
     --cron "0 */4 * * *" \
     --session isolated \
     --no-deliver \
     --message 'Tarea NaBoTo: persistencia WA. 1) sessions_list → sesiones con whatsapp:group. 2) sessions_history por cada una. 3) Por cada mensaje de usuario, exec curl -sS -X POST -H "Authorization: Bearer $NABOTO_INGEST_SECRET" -H "Content-Type: application/json" -d "{\"source_group\":\"...\",\"message_author\":\"...\",\"message_text\":\"...\",\"detected_type\":\"wa_live_group\"}" http://127.0.0.1:8080/api/naboto/observations (construí el JSON real por mensaje). No enviar mensajes a WhatsApp. Resumí cuántos insertaste.'
   ```
   Sustituí `8080` si tu `PORT` en Railway es otro. Si `NABOTO_INGEST_SECRET` no está definido en el servicio, configurála en **Variables** (misma que usás para ingest externo).

6. **Verificar**: `openclaw cron list`, enviar un mensaje de prueba en el grupo, tras la corrida (o `openclaw cron run <id> --due`) consultar `GET .../api/naboto/query/observations?hours=6`. El bot **no responde** en grupos en Fase 1 (`SOUL.md`).

**Si el gateway falló con config inválida** (`cron.jobs` o `groups` array): redeploy de esta imagen; al arrancar se elimina `cron.jobs` y se corrige `groups` si venía como array. Luego completá el paso 4–5.

### Fase 2: Bot activo (número NaBoTo oficial)

1. `openclaw channels logout --channel whatsapp`
2. `openclaw channels login --channel whatsapp` (QR con teléfono NaBoTo)
3. Actualizar config:
   ```bash
   openclaw config set channels.whatsapp.dmPolicy '"allowlist"'
   openclaw config set channels.whatsapp.sendReadReceipts true
   openclaw config set channels.whatsapp.reactionLevel '"ack"'
   openclaw config set channels.whatsapp.allowFrom '["+507..."]'
   ```
4. Quitar la sección "Fase 1 silencioso" de `SOUL.md` → el bot responde según reglas de roles/PII.

### Referencia

- [OpenClaw WhatsApp docs](https://docs.openclaw.ai/channels/whatsapp): `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `historyLimit`.
- Config gateway: `sanitizeCronConfig()` (quita `cron.jobs` obsoleto) + `ensureWhatsAppBaseline()` en `src/gateway.js`.
