import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommaJids,
  extractWhatsAppGroupJid,
  extractSenderDigits,
  buildObservationPayload,
} from '../hooks/naboto-wa-observations/handler.js';

describe('naboto-wa-observations hook', () => {
  it('parseCommaJids', () => {
    assert.deepEqual(parseCommaJids('a@g.us, b@g.us'), ['a@g.us', 'b@g.us']);
  });

  it('extractWhatsAppGroupJid', () => {
    assert.equal(
      extractWhatsAppGroupJid('whatsapp:group:120363024587546650@g.us', undefined, ''),
      '120363024587546650@g.us',
    );
    assert.equal(
      extractWhatsAppGroupJid(undefined, undefined, 'agent:x:whatsapp:group:120363024587546650@g.us'),
      '120363024587546650@g.us',
    );
  });

  it('extractSenderDigits', () => {
    assert.equal(extractSenderDigits('whatsapp:user:50762114762', undefined), '50762114762');
  });

  it('buildObservationPayload skips non-whatsapp', () => {
    const p = buildObservationPayload({ channelId: 'telegram' }, 'k');
    assert.equal(p, null);
  });

  it('buildObservationPayload group with allowlist off', () => {
    const prevGroup = process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST;
    const prevAllow = process.env.NABOTO_WA_ALLOWLIST_GROUP_JIDS;
    delete process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST;
    delete process.env.NABOTO_WA_ALLOWLIST_GROUP_JIDS;
    try {
      const p = buildObservationPayload(
        {
          channelId: 'whatsapp',
          isGroup: true,
          conversationId: 'whatsapp:group:120363024587546650@g.us',
          bodyForAgent: 'hola',
          senderName: 'Ana',
        },
        'agent:c:whatsapp:group:120363024587546650@g.us',
      );
      assert.ok(p);
      assert.equal(p.source_group, '120363024587546650@g.us');
      assert.equal(p.message_author, 'Ana');
      assert.equal(p.message_text, 'hola');
      assert.equal(p.detected_type, 'wa_live_group');
    } finally {
      if (prevGroup !== undefined) process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST = prevGroup;
      if (prevAllow !== undefined) process.env.NABOTO_WA_ALLOWLIST_GROUP_JIDS = prevAllow;
    }
  });

  it('buildObservationPayload group allowlist rejects unknown jid', () => {
    const prev = process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST;
    const prevAllow = process.env.NABOTO_WA_ALLOWLIST_GROUP_JIDS;
    process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST = '1';
    process.env.NABOTO_WA_ALLOWLIST_GROUP_JIDS = '999999999999999@g.us';
    try {
      const p = buildObservationPayload(
        {
          channelId: 'whatsapp',
          isGroup: true,
          conversationId: 'whatsapp:group:120363024587546650@g.us',
          bodyForAgent: 'x',
        },
        'k',
      );
      assert.equal(p, null);
    } finally {
      if (prev !== undefined) process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST = prev;
      else delete process.env.NABOTO_WA_HOOK_GROUP_ALLOWLIST;
      if (prevAllow !== undefined) process.env.NABOTO_WA_ALLOWLIST_GROUP_JIDS = prevAllow;
      else delete process.env.NABOTO_WA_ALLOWLIST_GROUP_JIDS;
    }
  });
});
