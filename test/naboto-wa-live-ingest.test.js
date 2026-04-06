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
  truncateObservationText,
  isWaRevokeOrDelete,
  isWaEdit,
  detectWaMediaKind,
  extractWaCaptionAndMeta,
  buildWaLiveObservationBody,
  previewItemRawText,
  previewItemsNewSincePrevious,
  stripPreviewMetadataHeaders,
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
    assert.equal(
      isWhatsAppIngestSessionKey('agent:c:WhatsApp:Group:120363410193914647@g.us'),
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
      sourceGroupFromSessionKey('agent:x:WhatsApp:Group:120363410193914647@g.us'),
      '120363410193914647@g.us',
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

  it('previewItemsNewSincePrevious diffs transcript tail', () => {
    const a = { role: 'user', text: 'a' };
    const b = { role: 'user', text: 'b' };
    const c = { role: 'user', text: 'c' };
    const r0 = previewItemsNewSincePrevious(undefined, [a, b]);
    assert.deepEqual(r0.newItems, [a, b]);
    assert.deepEqual(r0.nextSigs, ['user|a', 'user|b']);
    const r1 = previewItemsNewSincePrevious(r0.nextSigs, [a, b]);
    assert.deepEqual(r1.newItems, []);
    assert.deepEqual(r1.nextSigs, ['user|a', 'user|b']);
    const r2 = previewItemsNewSincePrevious(['user|a', 'user|b'], [b, c]);
    assert.deepEqual(r2.newItems, [c]);
    assert.deepEqual(r2.nextSigs, ['user|b', 'user|c']);
  });

  it('previewItemRawText and previewItemsNewSincePrevious use content when text missing', () => {
    assert.equal(previewItemRawText({ text: 'x' }), 'x');
    assert.equal(previewItemRawText({ content: 'y' }), 'y');
    assert.equal(previewItemRawText({ body: 'z' }), 'z');
    const a = { role: 'user', content: 'a' };
    const b = { role: 'user', content: 'b' };
    const r = previewItemsNewSincePrevious(undefined, [a, b]);
    assert.deepEqual(r.nextSigs, ['user|a', 'user|b']);
  });

  it('stripPreviewMetadataHeaders removes OpenClaw untrusted blocks', () => {
    const prefix =
      'Conversation info (untrusted metadata):\n```json\n{}\n```\n\n' +
      'Sender (untrusted metadata):\n```json\n{}\n```\n\n';
    assert.equal(stripPreviewMetadataHeaders(prefix + 'Hola equipo'), 'Hola equipo');
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

  const sk = 'agent:x:whatsapp:group:120363@g.us';

  it('truncateObservationText adds note when over limit', () => {
    const long = 'a'.repeat(500);
    const out = truncateObservationText(long, 320);
    assert.ok(out.length <= 320);
    assert.match(out, /truncado/);
    assert.match(out, /500/);
  });

  it('isWaRevokeOrDelete', () => {
    assert.equal(isWaRevokeOrDelete({ revoked: true }), true);
    assert.equal(isWaRevokeOrDelete({ type: 'revoke' }), true);
    assert.equal(isWaRevokeOrDelete({ event: 'delete' }), true);
    assert.equal(isWaRevokeOrDelete({ messageStubType: 1 }), true);
    assert.equal(isWaRevokeOrDelete({ role: 'user', content: 'hi' }), false);
  });

  it('isWaEdit', () => {
    assert.equal(isWaEdit({ edited: true }), true);
    assert.equal(isWaEdit({ editedAt: 1 }), true);
    assert.equal(isWaEdit({ type: 'edit' }), true);
    assert.equal(isWaEdit({ role: 'user', content: 'x' }), false);
  });

  it('detectWaMediaKind ignores generic type user/text', () => {
    assert.equal(detectWaMediaKind({ type: 'user', mimetype: 'image/png' }), 'imagen');
    assert.equal(detectWaMediaKind({ type: 'user' }), null);
    assert.equal(detectWaMediaKind({ type: 'sticker' }), 'sticker');
    assert.equal(detectWaMediaKind({ mediaType: 'ptt' }), 'audio');
  });

  it('extractWaCaptionAndMeta', () => {
    assert.match(extractWaCaptionAndMeta({ caption: 'c', fileName: 'f.pdf' }), /c/);
    assert.match(extractWaCaptionAndMeta({ mimetype: 'application/pdf' }), /mime:/);
  });

  it('buildWaLiveObservationBody revoke and plain text', () => {
    const rev = buildWaLiveObservationBody(
      { role: 'user', revoked: true, id: 'm1' },
      sk,
    );
    assert.equal(rev?.detected_type, 'wa_live_group_revoke');
    assert.match(rev?.message_text || '', /eliminado/);

    const plain = buildWaLiveObservationBody({ role: 'user', content: 'hola' }, sk);
    assert.equal(plain?.detected_type, 'wa_live_group');
    assert.equal(plain?.message_text, 'hola');
  });

  it('buildWaLiveObservationBody media and edit', () => {
    const media = buildWaLiveObservationBody(
      { role: 'user', mimetype: 'image/jpeg', content: '' },
      sk,
    );
    assert.equal(media?.detected_type, 'wa_live_group_media');
    assert.equal(media?.requires_review, true);

    const mediaCap = buildWaLiveObservationBody(
      { role: 'user', mimetype: 'image/jpeg', caption: 'sunset' },
      sk,
    );
    assert.equal(mediaCap?.requires_review, false);
    assert.match(mediaCap?.message_text || '', /sunset/);

    const ed = buildWaLiveObservationBody(
      { role: 'user', edited: true, content: 'fixed' },
      sk,
    );
    assert.equal(ed?.detected_type, 'wa_live_group_edit');
    assert.match(ed?.message_text || '', /editado/);
  });

  it('buildWaLiveObservationBody skips assistant', () => {
    assert.equal(buildWaLiveObservationBody({ role: 'assistant', content: 'x' }, sk), null);
  });
});
