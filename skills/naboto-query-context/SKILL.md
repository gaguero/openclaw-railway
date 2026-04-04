---
name: naboto_query_context
description: Use when the user asks about recent hotel operational chatter, group summaries, or NaBoTo observations. Read-only context from Postgres view v_naboto_observations_recent or tool access.
---

# NaBoTo — contexto de observaciones recientes

## Cuándo usar

- Preguntas sobre lo dicho recientemente en grupos operativos (si esos mensajes se guardaron en `bot_observations`).
- “Qué se reportó hoy”, “últimos avisos de X grupo” (si hay datos ingeridos).

## Reglas

1. **Solo lectura.** No insertar ni borrar en `bot_observations` desde esta skill salvo que otra herramienta explícita lo permita.
2. Si no hay herramienta SQL en este agente, pedir al operador que consulte `v_naboto_observations_recent` o el endpoint Lite `/lite/api/naboto/summary` (autenticado).
3. **No inventar** mensajes; si la tabla está vacía, decir que no hay observaciones recientes.
4. Aplicar **guardrails** de PII (ver `guardrails_permissions_matrix.md` en el proyecto memoria).

## Formato de respuesta

- Resumir por `source_group` y tiempo.
- Citas cortas; no volcar textos enormes sin que el usuario lo pida.
