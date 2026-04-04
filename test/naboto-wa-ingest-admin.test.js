import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  jsonlRowToObservationBody,
  WA_JSONL_SOURCES,
  normalizeWaJsonlSourceKey,
  waJsonlIngestParamsFromRequest,
} from '../src/naboto-wa-ingest-admin.js';

describe('jsonlRowToObservationBody', () => {
  it('builds body for standard row', () => {
    const b = jsonlRowToObservationBody({
      source_group: 'Test Group',
      format: 'standard',
      wa_time: '10:00 AM',
      wa_date: '1/15/2026',
      message_author: 'Alice',
      message_text: 'Hola',
    });
    assert.equal(b.source_group, 'Test Group');
    assert.match(b.message_text, /10:00 AM/);
    assert.match(b.message_text, /Hola/);
    assert.equal(b.message_author, 'Alice');
    assert.equal(b.detected_type, 'wa_export_history');
    assert.equal(b.requires_review, false);
  });

  it('returns null when no message text', () => {
    assert.equal(
      jsonlRowToObservationBody({
        source_group: 'G',
        format: 'standard',
        message_text: '   ',
      }),
      null,
    );
  });

  it('flags fragmented rows', () => {
    const b = jsonlRowToObservationBody({
      source_group: 'Room',
      format: 'fragmented',
      message_text: 'tail...',
      parser_note: 'x',
    });
    assert.equal(b.detected_type, 'wa_export_fragmented');
    assert.equal(b.requires_review, true);
  });
});

describe('WA_JSONL_SOURCES', () => {
  it('includes preview key', () => {
    assert.ok(WA_JSONL_SOURCES.preview);
  });
});

describe('waJsonlIngestParamsFromRequest', () => {
  it('GET always dry_run and reads query', () => {
    const p = waJsonlIngestParamsFromRequest({
      method: 'GET',
      query: { source: 'preview', limit: '10' },
      body: {},
    });
    assert.equal(p.sourceKey, 'preview');
    assert.equal(p.dryRun, true);
    assert.equal(p.limit, 10);
    assert.equal(p.invalidSource, false);
  });

  it('POST respects dry_run false', () => {
    const p = waJsonlIngestParamsFromRequest({
      method: 'POST',
      query: {},
      body: { source: 'preview', dry_run: false, limit: 5 },
    });
    assert.equal(p.dryRun, false);
    assert.equal(p.limit, 5);
  });
});

describe('normalizeWaJsonlSourceKey', () => {
  it('lowercases Preview', () => {
    assert.equal(normalizeWaJsonlSourceKey('Preview'), 'preview');
  });
  it('strips smart quotes', () => {
    assert.equal(normalizeWaJsonlSourceKey('«preview»'), 'preview');
  });
  it('maps aliases to preview', () => {
    assert.equal(normalizeWaJsonlSourceKey('JSONL'), 'preview');
    assert.equal(normalizeWaJsonlSourceKey('parsed-preview'), 'preview');
  });
  it('unknown values lowercased and must match WA_JSONL_SOURCES', () => {
    assert.equal(normalizeWaJsonlSourceKey('Staging'), 'staging');
    assert.equal(WA_JSONL_SOURCES[normalizeWaJsonlSourceKey('Staging')], undefined);
  });
});
