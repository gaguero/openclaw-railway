#!/usr/bin/env node
/**
 * CLI: parse WA GROUPS NBDT export → JSONL (one line per message).
 *
 * Usage:
 *   node scripts/parse-wa-groups-nbdt.mjs --input "C:/path/WA GROUPS NBDT.txt"
 *   node scripts/parse-wa-groups-nbdt.mjs --input ./file.txt --output ./out.jsonl
 *   node scripts/parse-wa-groups-nbdt.mjs --input ./file.txt --sections   # pretty JSON sections
 *
 * Do not commit real exports with PII to public git.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseWaGroupsExport, sectionsToJsonlRecords } from './wa-groups-parse-lib.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

const inputPath = arg('--input') || arg('-i');
const outputPath = arg('--output') || arg('-o');
const sectionsOnly = process.argv.includes('--sections');
const includeDescription = process.argv.includes('--with-description');

if (!inputPath) {
  console.error(
    'Usage: node scripts/parse-wa-groups-nbdt.mjs --input <path-to-WA-GROUPS.txt> [--output out.jsonl] [--sections] [--with-description]',
  );
  process.exit(1);
}

const abs = resolve(inputPath);
const text = readFileSync(abs, 'utf8');
const parsed = parseWaGroupsExport(text);

if (sectionsOnly) {
  const out = JSON.stringify(parsed.sections, null, 2);
  if (outputPath) {
    writeFileSync(resolve(outputPath), out, 'utf8');
  } else {
    process.stdout.write(out + '\n');
  }
  process.exit(0);
}

const rows = sectionsToJsonlRecords(parsed, { includeDescription });
const lines = rows.map((r) => JSON.stringify(r));
if (outputPath) {
  writeFileSync(resolve(outputPath), lines.join('\n') + '\n', 'utf8');
  console.error(`Wrote ${lines.length} JSONL lines to ${resolve(outputPath)}`);
} else {
  process.stdout.write(lines.join('\n') + '\n');
}

const fragmented = parsed.sections.filter((s) => s.format === 'fragmented').length;
if (fragmented > 0) {
  console.error(
    `Note: ${fragmented} section(s) used fragmented fallback (e.g. Room Division UI export). Review parser_note rows.`,
  );
}
