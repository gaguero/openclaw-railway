---
name: naboto_query_context
description: Use when the user asks about recent operational messages in the ingested observation feed (group chatter saved to Postgres), summaries by source_group, or what was reported lately. Read-only via v_naboto_observations_recent or Lite summary. Do not use for "who are you" or agent identity — that is SOUL.md / NaBoTo the assistant, not this feed.
---

# Feed de observaciones operativas (Postgres)

**No confundir:** vos sos el agente **NaBoTo** (persona, hotel). Esta skill describe solo cómo responder cuando preguntan por **mensajes operativos ya guardados** en `bot_observations` / vista `v_naboto_observations_recent`. Si el usuario pregunta **quién sos** o **“como NaBoTo”** en sentido personal, respondé según **SOUL.md**, no expliques esta vista como si “NaBoTo fuera una herramienta”.

## Cuándo usar

- Preguntas sobre lo dicho recientemente en grupos operativos **si** esos mensajes se guardaron en `bot_observations`.
- “Qué se reportó hoy”, “últimos avisos de X grupo” (si hay datos ingeridos).

## Reglas

1. **Solo lectura.** No insertar ni borrar en `bot_observations` desde esta skill salvo que otra herramienta explícita lo permita.
2. Si no hay herramienta SQL en este agente, pedir al operador que consulte `v_naboto_observations_recent` o el endpoint Lite `/lite/api/naboto/summary` (autenticado).
3. **No inventar** mensajes; si la tabla está vacía, decir que no hay observaciones recientes.
4. Aplicar **guardrails** de PII (ver `guardrails_permissions_matrix.md` en el proyecto memoria).

## Formato de respuesta

- Resumir por `source_group` y tiempo.
- Citas cortas; no volcar textos enormes sin que el usuario lo pida.
