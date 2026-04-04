/**
 * NaBoTo template: agent identity merge for openclaw.json
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureNabotoAgentIdentity,
  ensureNabotoQuerySkillForAgents,
  NABOTO_QUERY_SKILL_ID,
  NABOTO_AGENT_DB_SKILLS,
  getDefaultConfig,
} from '../src/schema/migrate.js';

describe('ensureNabotoAgentIdentity', () => {
  it('adds list with main agent when missing', () => {
    const config = { agents: { defaults: { model: { primary: 'x' } } } };
    assert.equal(ensureNabotoAgentIdentity(config), true);
    assert.equal(config.agents.list[0].id, 'main');
    assert.equal(config.agents.list[0].default, true);
    assert.equal(config.agents.list[0].identity.name, 'NaBoTo');
  });

  it('replaces generic OpenClaw name', () => {
    const config = {
      agents: {
        list: [{ id: 'main', default: true, identity: { name: 'OpenClaw' } }],
      },
    };
    assert.equal(ensureNabotoAgentIdentity(config), true);
    assert.equal(config.agents.list[0].identity.name, 'NaBoTo');
    assert.ok(config.agents.list[0].identity.theme.includes('Nayara'));
  });

  it('does not overwrite a custom name', () => {
    const config = {
      agents: {
        list: [{ id: 'main', default: true, identity: { name: 'María' } }],
      },
    };
    assert.equal(ensureNabotoAgentIdentity(config), false);
    assert.equal(config.agents.list[0].identity.name, 'María');
  });

  it('getDefaultConfig includes NaBoTo identity', () => {
    const c = getDefaultConfig(8080);
    assert.equal(c.agents.list[0].identity.name, 'NaBoTo');
  });
});

describe('ensureNabotoQuerySkillForAgents', () => {
  it('returns false when no database URL', () => {
    const config = {
      agents: {
        defaults: {},
        list: [{ id: 'coordinador', skills: ['other'] }],
      },
    };
    assert.equal(ensureNabotoQuerySkillForAgents(config, { databaseUrl: '' }), false);
    assert.deepEqual(config.agents.list[0].skills, ['other']);
  });

  it('removes invalid agents.defaults.skills', () => {
    const config = {
      agents: {
        defaults: { skills: ['naboto-query-context', 'x'] },
        list: [],
      },
    };
    assert.equal(
      ensureNabotoQuerySkillForAgents(config, { databaseUrl: 'postgres://x' }),
      true,
    );
    assert.equal(Object.hasOwn(config.agents.defaults, 'skills'), false);
  });

  it('merges NaBoTo DB skills into agents.list entries with explicit skills array', () => {
    const config = {
      agents: {
        defaults: { model: { primary: 'x' } },
        list: [
          { id: 'main', default: true, skills: ['memory-core'] },
          { id: 'coordinador', skills: [] },
          { id: 'bare' },
        ],
      },
    };
    assert.equal(
      ensureNabotoQuerySkillForAgents(config, { databaseUrl: 'postgres://x' }),
      true,
    );
    for (const skill of NABOTO_AGENT_DB_SKILLS) {
      assert.ok(config.agents.list[0].skills.includes(skill));
      assert.ok(config.agents.list[1].skills.includes(skill));
    }
    assert.equal(Object.hasOwn(config.agents.list[2], 'skills'), false);
  });

  it('is idempotent when all NaBoTo DB skills already present on list agent', () => {
    const config = {
      agents: {
        defaults: {},
        list: [{ id: 'main', skills: [...NABOTO_AGENT_DB_SKILLS] }],
      },
    };
    assert.equal(
      ensureNabotoQuerySkillForAgents(config, { databaseUrl: 'postgres://x' }),
      false,
    );
    assert.deepEqual(config.agents.list[0].skills, NABOTO_AGENT_DB_SKILLS);
  });
});
