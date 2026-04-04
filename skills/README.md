# Skills del fork (NaBoTo / hotel)

## Convención

- Cada skill = carpeta con **`SKILL.md`** (frontmatter `name` + `description`).
- Nombres en **snake_case**; `description` clara para que el agente decida cuándo invocar.
- Skills adicionales del ecosistema OpenClaw: ClawHub o `~/.openclaw/skills` según doc oficial.

## NaBoTo en este repo

| Carpeta | Uso |
|---------|-----|
| `naboto-query-context/` | Contexto de mensajes ingeridos (`bot_observations` / vista reciente). |
| `naboto-wa-ingest/` | Parseo de export WA + dry-run / ingesta JSONL vía API admin (conversación en UI). |

Instalar en el volumen del contenedor vía Lite terminal o `openclaw` CLI según tu flujo de deploy.
