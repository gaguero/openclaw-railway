import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWhatsAppIngestSessionKey,
  sourceGroupFromSessionKey,
  detectedTypeForSessionKey,
  extractTextFromMessageContent,
  normalizeTranscriptRow,
  sessionKeyFromEventPayload,
  messageObjectFromEventPayload,
} from '../src/naboto-wa-live-ingest.js';

describe('naboto-wa-live-ingest', () => {
  it('isWhatsAppIngestSessionKey filters groups and direct, skips cron', () => {
    assert.equal(
      isWhatsAppIngestSessionKey('agent:coordinador:whatsapp:group:120363@g.us'),
      true,
    );
    assert.equal(
      isWhatsAppIngestSessionKey('agent:coordinador:whatsapp:direct:507@s.whatsapp.net'),
      true,
    );
    assert.equal(isWhatsAppIngestSessionKey('agent:coordinador:cron:x:run:y'), false);
    assert.equal(isWhatsAppIngestSessionKey('agent:coordinador:main'), false);
  });

  it('sourceGroupFromSessionKey extracts JID', () => {
    assert.equal(
      sourceGroupFromSessionKey('agent:x:whatsapp:group:120363024587546650@g.us'),
      '120363024587546650@g.us',
    );
    assert.equal(
      sourceGroupFromSessionKey('agent:x:whatsapp:direct:50762114762@s.whatsapp.net'),
      '50762114762@s.whatsapp.net',
    );
  });

  it('detectedTypeForSessionKey', () => {
    assert.equal(detectedTypeForSessionKey('a:whatsapp:group:x@g.us'), 'wa_live_group');
    assert.equal(detectedTypeForSessionKey('a:whatsapp:direct:x@s.whatsapp.net'), 'wa_live_dm');
  });

  it('extractTextFromMessageContent', () => {
    assert.equal(extractTextFromMessageContent('hola'), 'hola');
    assert.equal(
      extractTextFromMessageContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
      'a\nb',
    );
  });

  it('normalizeTranscriptRow skips assistant', () => {
    const u = normalizeTranscriptRow({ role: 'user', content: 'hi', author: 'Juan' });
    assert.equal(u.role, 'user');
    assert.equal(u.text, 'hi');
    assert.equal(u.author, 'Juan');
    const a = normalizeTranscriptRow({ role: 'assistant', content: 'no' });
    assert.equal(a.text, 'no');
    assert.equal(a.role, 'assistant');
  });

  it('sessionKeyFromEventPayload', () => {
    assert.equal(sessionKeyFromEventPayload({ sessionKey: 'k1' }), 'k1');
    assert.equal(sessionKeyFromEventPayload({ key: 'k2' }), 'k2');
    assert.equal(sessionKeyFromEventPayload({ session: { key: 'k3' } }), 'k3');
  });

  it('messageObjectFromEventPayload', () => {
    assert.deepEqual(messageObjectFromEventPayload({ message: { role: 'user' } }), {
      role: 'user',
    });
  });
});
