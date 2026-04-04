import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseWaGroupsExport, sectionsToJsonlRecords } from '../scripts/wa-groups-parse-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplePath = join(__dirname, '..', 'scripts', 'fixtures', 'wa-groups-sample.txt');

describe('parseWaGroupsExport', () => {
  it('parses sample fixture: 3 sections, standard timestamps', () => {
    const text = readFileSync(samplePath, 'utf8');
    const { sections } = parseWaGroupsExport(text);
    assert.strictEqual(sections.length, 3);
    assert.ok(sections[0].source_group.includes('Test Alpha'));
    assert.strictEqual(sections[0].messages.length, 2);
    assert.strictEqual(sections[0].messages[0].message_author, 'Alice Test');
    assert.ok(sections[0].messages[0].message_text.includes('Mensaje uno'));
    assert.ok(sections[0].messages[0].message_text.includes('segunda linea'));
    assert.strictEqual(sections[1].messages.length, 1);
    assert.ok(sections[1].messages[0].message_text.includes('Traslado prueba'));
    assert.strictEqual(sections[2].messages.length, 1);
  });

  it('sectionsToJsonlRecords returns one row per message', () => {
    const text = readFileSync(samplePath, 'utf8');
    const parsed = parseWaGroupsExport(text);
    const rows = sectionsToJsonlRecords(parsed);
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0].idx, 0);
    assert.strictEqual(rows[3].section_index, 2);
  });
});
