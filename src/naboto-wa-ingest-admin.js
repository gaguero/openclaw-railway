/**
 * NaBoTo — bulk ingest from bundled WA JSONL (gateway token auth).
 * Lets the chat agent run dry-run / ingest via exec + curl (same auth as query API).
 */

import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { resolve, sep } from 'path';
import { pathToFileURL } from 'url';
import { getNabotoPool } from './naboto-pool.js';
import { insertBotObservation } from './naboto-observations.js';

/** Keys → paths relative to process.cwd() (Docker: /app). */
export const WA_JSONL_SOURCES = {
  preview: 'scripts/fixtures/_parsed-preview.jsonl',
};

const MAX_PARSE_CHARS = 2_000_000;
const MAX_INGEST_ROWS = 5000;

/**
 * Map one JSONL record from wa-groups parser → body for insertBotObservation.
 * @param {object} row
 * @returns {object|null} null = skip
 */
export function jsonlRowToObservationBody(row) {
  if (!row || typeof row !== 'object') return null;
  const sourceGroup = String(row.source_group || '').trim().slice(0, 240) || 'unknown';
  const parts = [];
  if (row.wa_time && row.wa_date) {
    parts.push(`[${String(row.wa_time).trim()}, ${String(row.wa_date).trim()}]`);
  }
  const rawText = typeof row.message_text === 'string' ? row.message_text : '';
  if (rawText.trim()) parts.push(rawText.trim());
  const messageText = parts.join(' ').trim();
  if (!messageText) return null;

  const messageAuthor =
    typeof row.message_author === 'string' && row.message_author.trim()
      ? row.message_author.trim().slice(0, 500)
      : null;

  const fragmented = row.format === 'fragmented' || Boolean(row.parser_note);
  return {
    source_group: sourceGroup,
    message_text: messageText,
    message_author: messageAuthor,
    detected_type: fragmented ? 'wa_export_fragmented' : 'wa_export_history',
    requires_review: fragmented,
  };
}

function resolveSourcePath(sourceKey) {
  const rel = WA_JSONL_SOURCES[sourceKey];
  if (!rel) return null;
  const cwd = resolve(process.cwd());
  const abs = resolve(cwd, rel);
  if (!abs.startsWith(cwd + sep) && abs !== cwd) {
    return null;
  }
  return abs;
}

/**
 * POST JSON: { source: "preview", dry_run?: boolean, limit?: number }
 */
export async function nabotoWaJsonlIngestHandler(req, res) {
  const pool = getNabotoPool();
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'DATABASE_URL not configured' });
  }

  const body = req.body || {};
  const sourceKey = typeof body.source === 'string' ? body.source.trim() : '';
  const dryRun = Boolean(body.dry_run);
  let limit = parseInt(String(body.limit ?? ''), 10);
  if (Number.isNaN(limit) || limit < 1) limit = MAX_INGEST_ROWS;
  limit = Math.min(limit, MAX_INGEST_ROWS);

  if (!sourceKey || !WA_JSONL_SOURCES[sourceKey]) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid source',
      allowed: Object.keys(WA_JSONL_SOURCES),
    });
  }

  const filePath = resolveSourcePath(sourceKey);
  if (!filePath || !existsSync(filePath)) {
    return res.status(404).json({
      ok: false,
      error: 'JSONL file not found on server',
      path: WA_JSONL_SOURCES[sourceKey],
      hint: 'Rebuild image with scripts/fixtures copied, or pick another source',
    });
  }

  const stats = {
    ok: true,
    dry_run: dryRun,
    source: sourceKey,
    file: WA_JSONL_SOURCES[sourceKey],
    total_lines: 0,
    json_ok: 0,
    skipped_empty: 0,
    inserted: 0,
    errors: [],
  };

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let successCount = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    stats.total_lines += 1;

    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      stats.errors.push({ line: stats.total_lines, error: 'invalid JSON' });
      if (stats.errors.length >= 50) break;
      continue;
    }

    stats.json_ok += 1;
    const obsBody = jsonlRowToObservationBody(row);
    if (!obsBody) {
      stats.skipped_empty += 1;
      continue;
    }

    if (successCount >= limit) break;

    if (dryRun) {
      successCount += 1;
      stats.inserted += 1;
      continue;
    }

    const ins = await insertBotObservation(pool, obsBody);
    if (!ins.ok) {
      stats.errors.push({
        line: stats.total_lines,
        status: ins.status,
        detail: ins.json,
      });
      if (stats.errors.length >= 50) break;
    } else {
      successCount += 1;
      stats.inserted += 1;
    }
  }

  return res.status(200).json(stats);
}

/**
 * POST JSON: { text: string } — parse export; returns counts + optional sample rows (no DB).
 */
export async function nabotoWaParseHandler(req, res) {
  const raw = req.body?.text;
  if (typeof raw !== 'string') {
    return res.status(400).json({ ok: false, error: 'Body must include string "text"' });
  }
  if (raw.length > MAX_PARSE_CHARS) {
    return res.status(400).json({
      ok: false,
      error: `text exceeds ${MAX_PARSE_CHARS} characters`,
    });
  }

  const libPath = resolve(process.cwd(), 'scripts/wa-groups-parse-lib.mjs');
  if (!existsSync(libPath)) {
    return res.status(503).json({
      ok: false,
      error: 'Parser not deployed (missing scripts/wa-groups-parse-lib.mjs)',
    });
  }

  let mod;
  try {
    mod = await import(pathToFileURL(libPath).href);
  } catch (e) {
    console.error('[naboto-wa-parse]', e.message);
    return res.status(500).json({ ok: false, error: 'Failed to load parser module' });
  }

  const { parseWaGroupsExport, sectionsToJsonlRecords } = mod;
  const parsed = parseWaGroupsExport(raw);
  const records = sectionsToJsonlRecords(parsed, { includeDescription: false });
  const sample = records.slice(0, 5);

  return res.json({
    ok: true,
    sections: parsed.sections.length,
    records: records.length,
    sample,
  });
}
