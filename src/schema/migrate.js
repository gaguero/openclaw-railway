/**
 * Config migration logic for OpenClaw
 *
 * Handles transforming legacy config shapes into the current schema.
 * Migrations are idempotent — running on an already-migrated config is a no-op.
 *
 * Based on OpenClaw's legacy.migrations.part-2.ts and part-3.ts:
 *   agent.model (string)       → agents.defaults.model.primary
 *   agent.model (object)       → merge into agents.defaults.model
 *   agent.modelFallbacks       → agents.defaults.model.fallbacks
 *   agent.imageModel           → agents.defaults.imageModel.primary
 *   agent.tools.allow/deny     → tools.allow/deny
 *   agent.elevated             → tools.elevated
 *   agent.bash                 → tools.exec
 *   agent.sandbox.tools        → tools.sandbox.tools
 *   agent.subagents.tools      → tools.subagents.tools
 *   Remaining agent.*          → agents.defaults.*
 */

/**
 * Migrate a config object from legacy format to current format (in-place).
 * Returns true if any migrations were applied, false otherwise.
 *
 * @param {Object} config - Config object (mutated in place)
 * @returns {{ migrated: boolean, changes: string[] }}
 */
export function migrateConfig(config) {
  const changes = [];

  if (!config || typeof config !== 'object') {
    return { migrated: false, changes };
  }

  // Legacy: agent.* → agents.defaults.* + tools.*
  if (config.agent) {
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.tools = config.tools || {};

    const agent = config.agent;

    // agent.model → agents.defaults.model
    if (agent.model !== undefined) {
      config.agents.defaults.model = config.agents.defaults.model || {};
      if (typeof agent.model === 'string') {
        config.agents.defaults.model.primary = agent.model;
        changes.push('agent.model (string) → agents.defaults.model.primary');
      } else if (typeof agent.model === 'object' && agent.model !== null) {
        Object.assign(config.agents.defaults.model, agent.model);
        changes.push('agent.model (object) → agents.defaults.model');
      }
      delete agent.model;
    }

    // agent.modelFallbacks → agents.defaults.model.fallbacks
    if (agent.modelFallbacks !== undefined) {
      config.agents.defaults.model = config.agents.defaults.model || {};
      config.agents.defaults.model.fallbacks = agent.modelFallbacks;
      changes.push('agent.modelFallbacks → agents.defaults.model.fallbacks');
      delete agent.modelFallbacks;
    }

    // agent.imageModel → agents.defaults.imageModel
    if (agent.imageModel !== undefined) {
      if (typeof agent.imageModel === 'string') {
        config.agents.defaults.imageModel = { primary: agent.imageModel };
        changes.push('agent.imageModel (string) → agents.defaults.imageModel.primary');
      } else {
        config.agents.defaults.imageModel = agent.imageModel;
        changes.push('agent.imageModel (object) → agents.defaults.imageModel');
      }
      delete agent.imageModel;
    }

    // agent.tools.allow/deny → tools.allow/deny
    if (agent.tools) {
      if (agent.tools.allow !== undefined) {
        config.tools.allow = agent.tools.allow;
        changes.push('agent.tools.allow → tools.allow');
      }
      if (agent.tools.deny !== undefined) {
        config.tools.deny = agent.tools.deny;
        changes.push('agent.tools.deny → tools.deny');
      }
      delete agent.tools;
    }

    // agent.elevated → tools.elevated
    if (agent.elevated !== undefined) {
      config.tools.elevated = agent.elevated;
      changes.push('agent.elevated → tools.elevated');
      delete agent.elevated;
    }

    // agent.bash → tools.exec
    if (agent.bash !== undefined) {
      config.tools.exec = agent.bash;
      changes.push('agent.bash → tools.exec');
      delete agent.bash;
    }

    // agent.sandbox.tools → tools.sandbox.tools
    if (agent.sandbox?.tools !== undefined) {
      config.tools.sandbox = config.tools.sandbox || {};
      config.tools.sandbox.tools = agent.sandbox.tools;
      changes.push('agent.sandbox.tools → tools.sandbox.tools');
      delete agent.sandbox.tools;
      // Move remaining sandbox keys to agents.defaults.sandbox
      if (Object.keys(agent.sandbox).length > 0) {
        config.agents.defaults.sandbox = config.agents.defaults.sandbox || {};
        Object.assign(config.agents.defaults.sandbox, agent.sandbox);
      }
      delete agent.sandbox;
    }

    // agent.subagents.tools → tools.subagents.tools
    if (agent.subagents?.tools !== undefined) {
      config.tools.subagents = config.tools.subagents || {};
      config.tools.subagents.tools = agent.subagents.tools;
      changes.push('agent.subagents.tools → tools.subagents.tools');
      delete agent.subagents.tools;
      if (Object.keys(agent.subagents).length > 0) {
        config.agents.defaults.subagents = config.agents.defaults.subagents || {};
        Object.assign(config.agents.defaults.subagents, agent.subagents);
      }
      delete agent.subagents;
    }

    // Move all remaining agent.* keys to agents.defaults.*
    for (const [key, value] of Object.entries(agent)) {
      config.agents.defaults[key] = value;
      changes.push(`agent.${key} → agents.defaults.${key}`);
    }

    delete config.agent;

    // Clean up empty tools object if nothing was migrated into it
    if (Object.keys(config.tools).length === 0) {
      delete config.tools;
    }
  }

  // Legacy: gateway.token → gateway.auth.token (already handled in gateway.js, but be safe)
  if (config.gateway?.token && !config.gateway?.auth) {
    config.gateway.auth = { mode: 'token', token: config.gateway.token };
    delete config.gateway.token;
    changes.push('gateway.token → gateway.auth');
  }

  return { migrated: changes.length > 0, changes };
}

/** Names treated as generic upstream defaults → replace with NaBoTo in this Railway template */
const NABOTO_REPLACE_IDENTITY_NAMES = new Set([
  '',
  'OpenClaw',
  'openclaw',
  'Assistant',
  'Claw',
]);

const NABOTO_AGENT_IDENTITY = {
  name: 'NaBoTo',
  theme: 'asistente operativo Guest Experience, Nayara Bocas del Toro, hotel NBDT',
  emoji: '🏨',
};

/** Skill id = folder name + SKILL frontmatter `name` (must match). */
export const NABOTO_QUERY_SKILL_ID = 'naboto-query-context';

/** Merged into agents with explicit `skills` when DATABASE_URL is set (gateway enables these). */
export const NABOTO_AGENT_DB_SKILLS = ['naboto-query-context', 'naboto-wa-ingest'];

/** OpenRouter meta-model; often yields Provider finish_reason: error in production. */
export const OPENROUTER_AUTO_PRIMARY = 'openrouter/openrouter/auto';

/**
 * Stable default when replacing {@link OPENROUTER_AUTO_PRIMARY}. Override with `OPENROUTER_PRIMARY_MODEL`.
 * @returns {string}
 */
export function openRouterPrimaryFallback() {
  const v = (process.env.OPENROUTER_PRIMARY_MODEL || 'openrouter/openai/gpt-4o-mini').trim();
  return v || 'openrouter/openai/gpt-4o-mini';
}

/**
 * Replace `openrouter/openrouter/auto` (and `openrouter/auto`) with a fixed OpenRouter model id.
 * Skipped when `OPENCLAW_KEEP_OPENROUTER_AUTO=1` or `true`.
 *
 * @param {Object} config
 * @returns {boolean} true if config changed
 */
export function replaceOpenRouterAutoPrimary(config) {
  if (process.env.OPENCLAW_KEEP_OPENROUTER_AUTO === '1' || process.env.OPENCLAW_KEEP_OPENROUTER_AUTO === 'true') {
    return false;
  }
  if (!config || typeof config !== 'object') {
    return false;
  }

  const fallback = openRouterPrimaryFallback();
  const isAuto = s => s === OPENROUTER_AUTO_PRIMARY || s === 'openrouter/auto';

  let changed = false;
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = config.agents.defaults.model || {};
  const defPrimary = config.agents.defaults.model.primary;
  if (typeof defPrimary === 'string' && isAuto(defPrimary)) {
    config.agents.defaults.model.primary = fallback;
    changed = true;
  }

  const list = config.agents.list;
  if (Array.isArray(list)) {
    for (const agent of list) {
      if (!agent || typeof agent !== 'object') continue;
      if (agent.model && typeof agent.model === 'object' && typeof agent.model.primary === 'string' && isAuto(agent.model.primary)) {
        agent.model.primary = fallback;
        changed = true;
      }
      if (typeof agent.model === 'string' && isAuto(agent.model)) {
        agent.model = fallback;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Ensure Postgres read skill for agents when DATABASE_URL is set.
 *
 * OpenClaw builds shipped with this image reject `agents.defaults.skills` (config invalid).
 * Global enable stays in `skills.entries` for NaBoTo DB skills (gateway.js).
 *
 * For each `agents.list[]` entry that **explicitly** sets `skills` (including `[]`),
 * merge in `naboto-query-context` and `naboto-wa-ingest`. Agents without a `skills` key inherit all enabled
 * global skills — do not add a `skills` array (that would replace the default allowlist).
 *
 * Removes legacy `agents.defaults.skills` if present (fixes broken deploys).
 *
 * @param {Object} config
 * @param {{ databaseUrl?: string }} [opts] pass DATABASE_URL for tests
 * @returns {boolean} true if config changed
 */
export function ensureNabotoQuerySkillForAgents(config, opts = {}) {
  const dbUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!dbUrl || !String(dbUrl).trim()) {
    return false;
  }
  if (!config?.agents || typeof config.agents !== 'object') {
    return false;
  }

  let changed = false;

  config.agents.defaults = config.agents.defaults || {};
  if (Object.hasOwn(config.agents.defaults, 'skills')) {
    delete config.agents.defaults.skills;
    changed = true;
  }

  const list = config.agents.list;
  if (Array.isArray(list)) {
    for (const agent of list) {
      if (!agent || typeof agent !== 'object') continue;
      if (!Object.hasOwn(agent, 'skills')) continue;
      const s = agent.skills;
      if (!Array.isArray(s)) continue;
      const next = [...s];
      let skillsChanged = false;
      for (const skill of NABOTO_AGENT_DB_SKILLS) {
        if (!next.includes(skill)) {
          next.push(skill);
          skillsChanged = true;
        }
      }
      if (skillsChanged) {
        agent.skills = next;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Ensure the default agent presents as NaBoTo (identity in openclaw.json → chat UI + model context).
 * Does not overwrite a custom agent name (anything not in {@link NABOTO_REPLACE_IDENTITY_NAMES}).
 *
 * @param {Object} config - Full openclaw config (mutated in place)
 * @returns {boolean} True if config was changed
 */
export function ensureNabotoAgentIdentity(config) {
  if (!config || typeof config !== 'object') {
    return false;
  }
  config.agents = config.agents || {};
  const list = config.agents.list;

  if (!Array.isArray(list) || list.length === 0) {
    config.agents.list = [
      {
        id: 'main',
        default: true,
        identity: { ...NABOTO_AGENT_IDENTITY },
      },
    ];
    return true;
  }

  const defaultIdx = list.findIndex(a => a && a.default === true);
  const mainIdx = list.findIndex(a => a && a.id === 'main');
  const idx = defaultIdx >= 0 ? defaultIdx : (mainIdx >= 0 ? mainIdx : 0);
  const agent = list[idx];
  if (!agent || typeof agent !== 'object') {
    return false;
  }

  agent.identity = agent.identity || {};
  const name = String(agent.identity.name ?? '').trim();
  if (!name || NABOTO_REPLACE_IDENTITY_NAMES.has(name)) {
    Object.assign(agent.identity, NABOTO_AGENT_IDENTITY);
    return true;
  }

  return false;
}

/**
 * Get the default minimal config for a new installation
 * @param {number} port - Gateway port
 * @returns {Object} Minimal valid config
 */
export function getDefaultConfig(port) {
  return {
    agents: {
      defaults: {
        model: {
          primary: 'anthropic/claude-sonnet-4'
        },
      },
      list: [
        {
          id: 'main',
          default: true,
          identity: { ...NABOTO_AGENT_IDENTITY },
        },
      ],
    },
    memory: {
      backend: 'builtin'
    },
    gateway: {
      port: parseInt(port, 10) || 18789
    }
  };
}
