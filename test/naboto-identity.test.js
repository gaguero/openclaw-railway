/**
 * NaBoTo template: agent identity merge for openclaw.json
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureNabotoAgentIdentity, getDefaultConfig } from '../src/schema/migrate.js';

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
