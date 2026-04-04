/**
 * Replace openrouter/openrouter/auto with a fixed primary (mitigate Provider finish_reason: error)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  replaceOpenRouterAutoPrimary,
  OPENROUTER_AUTO_PRIMARY,
} from '../src/schema/migrate.js';

describe('replaceOpenRouterAutoPrimary', () => {
  it('replaces agents.defaults.model.primary when auto', () => {
    const config = {
      agents: {
        defaults: { model: { primary: OPENROUTER_AUTO_PRIMARY } },
        list: [],
      },
    };
    assert.equal(replaceOpenRouterAutoPrimary(config), true);
    assert.match(config.agents.defaults.model.primary, /^openrouter\//);
    assert.notEqual(config.agents.defaults.model.primary, OPENROUTER_AUTO_PRIMARY);
  });

  it('replaces per-agent model.primary in list', () => {
    const config = {
      agents: {
        defaults: { model: { primary: 'anthropic/claude-sonnet-4' } },
        list: [{ id: 'coordinador', model: { primary: OPENROUTER_AUTO_PRIMARY } }],
      },
    };
    assert.equal(replaceOpenRouterAutoPrimary(config), true);
    assert.notEqual(config.agents.list[0].model.primary, OPENROUTER_AUTO_PRIMARY);
  });

  it('returns false when primary is already fixed', () => {
    const config = {
      agents: {
        defaults: { model: { primary: 'openrouter/openai/gpt-4o-mini' } },
      },
    };
    assert.equal(replaceOpenRouterAutoPrimary(config), false);
  });
});
