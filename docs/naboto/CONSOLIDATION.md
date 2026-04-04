# Consolidación NaBoTo en OpenClaw (Railway)

## Qué queda después de consolidar

- **Identidad** en config: nombre *NaBoTo*, emoji 🏨 — el **wrapper** aplica `ensureNabotoAgentIdentity` en cada arranque del gateway: si el agente por defecto no tiene nombre o tiene un nombre genérico (`OpenClaw`, `Assistant`, etc.), se escribe NaBoTo en `openclaw.json`. Un nombre **personalizado** no se pisa.
- **Personalidad y reglas** en `SOUL.md` del workspace (inyectado al contexto del agente).
- **Skill** `naboto-query-context` disponible desde `/bundled-skills` (vía `skills.load.extraDirs`).
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
   - `agents.defaults.skills` → incluí `naboto-query-context` o mergeá con tus skills existentes
4. Validá JSON y reiniciá gateway.

## Paso 3 — Skill en workspace (alternativa)

Si no querés `extraDirs`, copiá la carpeta del skill al workspace:

```bash
mkdir -p /data/workspace/skills
cp -r /bundled-skills/naboto-query-context /data/workspace/skills/
```

## Paso 4 — Verificación

1. Chat en `/openclaw`: el agente debe presentarse acorde a **NaBoTo** y seguir reglas de SOUL.
2. `GET /lite/api/naboto/summary` (logueado): observaciones recientes en DB.
3. **Consultas para el agente:** `GET /api/naboto/query` con header `Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN` (mismo token que el proxy). Probar desde SSH del contenedor: `curl -sS -H "Authorization: Bearer $OPENCLAW_GATEWAY_TOKEN" "http://127.0.0.1:${PORT}/api/naboto/query"`.
4. **AppSheet (opcional):** con `APPSHEET_*` configuradas, `GET /api/naboto/appsheet` y `GET /api/naboto/appsheet/find/NombreTabla?limit=10`.

## WhatsApp (después)

Seguir [OpenClaw WhatsApp](https://docs.openclaw.ai/channels/whatsapp): `dmPolicy`, `allowFrom`, `groupPolicy`, QR login.
