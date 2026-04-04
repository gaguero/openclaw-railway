/**
 * NaBoTo — AppSheet read-only (Find) for the agent.
 * Auth: same as other NaBoTo query routes (Bearer OPENCLAW_GATEWAY_TOKEN).
 *
 * Env:
 *   APPSHEET_APP_ID           — required
 *   APPSHEET_ACCESS_KEY       — Application Access Key (V2-…)
 *   APPSHEET_READONLY_TABLES  — comma list of exact table names allowed (required for /find)
 *   APPSHEET_API_HOST         — default www.appsheet.com (global); eu / asia per Google docs
 *   APPSHEET_LOCALE           — optional, default en-US
 */

import {
  DEFAULT_APPSHEET_HOST,
  TABLE_NAME_RE,
  parseAppsheetAllowlist,
  appsheetEnvConfigured,
  buildAppsheetFindBody,
  clampAppsheetLimit,
} from './naboto-appsheet-helpers.js';

function parseAllowlistedTables() {
  return parseAppsheetAllowlist(process.env.APPSHEET_READONLY_TABLES);
}

function appsheetConfigured() {
  return appsheetEnvConfigured(process.env);
}

/**
 * GET /health/naboto-appsheet — no auth; does not call AppSheet API.
 */
export async function nabotoAppsheetHealthHandler(_req, res) {
  const configured = appsheetConfigured();
  const tables = parseAllowlistedTables();

  if (!configured) {
    return res.json({
      ok: true,
      appsheet: 'not_configured',
      hint: 'Set APPSHEET_APP_ID and APPSHEET_ACCESS_KEY to enable',
    });
  }

  const body = {
    ok: true,
    appsheet: 'configured',
    allowlisted_table_count: tables.length,
    host: process.env.APPSHEET_API_HOST?.trim() || DEFAULT_APPSHEET_HOST,
  };

  if (tables.length === 0) {
    body.warn = 'APPSHEET_READONLY_TABLES is empty — /find will return 503';
  }

  return res.json(body);
}

export async function nabotoAppsheetIndexHandler(_req, res) {
  const tables = parseAllowlistedTables();
  return res.json({
    ok: true,
    configured: appsheetConfigured(),
    allowlisted_tables: tables,
    host: process.env.APPSHEET_API_HOST?.trim() || DEFAULT_APPSHEET_HOST,
    note: 'Solo lectura (Find). Writes prohibidos por política NaBoTo.',
  });
}

/**
 * GET .../find/:tableName?limit=25
 */
export async function nabotoAppsheetFindHandler(req, res) {
  if (!appsheetConfigured()) {
    return res.status(503).json({
      ok: false,
      error: 'AppSheet not configured',
      hint: 'Set APPSHEET_APP_ID and APPSHEET_ACCESS_KEY on Railway',
    });
  }

  const allow = parseAllowlistedTables();
  if (allow.length === 0) {
    return res.status(503).json({
      ok: false,
      error: 'APPSHEET_READONLY_TABLES is empty',
      hint: 'Set comma-separated AppSheet table names (exact names from Data > Tables)',
    });
  }

  const tableName = decodeURIComponent(req.params.tableName || '').trim();
  if (!TABLE_NAME_RE.test(tableName) || !allow.includes(tableName)) {
    return res.status(400).json({
      ok: false,
      error: 'Unknown or disallowed table',
      allowlisted_tables: allow,
    });
  }

  const limit = clampAppsheetLimit(req.query.limit, 25);
  const host = process.env.APPSHEET_API_HOST?.trim() || DEFAULT_APPSHEET_HOST;
  const appId = process.env.APPSHEET_APP_ID.trim();
  const key = process.env.APPSHEET_ACCESS_KEY.trim();
  const pathTable = encodeURIComponent(tableName);
  const url = `https://${host}/api/v2/apps/${appId}/tables/${pathTable}/Action`;

  const locale = process.env.APPSHEET_LOCALE || 'en-US';
  const body = buildAppsheetFindBody(tableName, limit, locale);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ApplicationAccessKey: key,
      },
      body: JSON.stringify(body),
    });

    const text = await r.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return res.status(502).json({
        ok: false,
        error: 'AppSheet returned non-JSON',
        status: r.status,
        preview: text.slice(0, 200),
      });
    }

    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: 'AppSheet API error',
        status: r.status,
        detail: payload,
      });
    }

    const rows = Array.isArray(payload?.Rows) ? payload.Rows : [];
    return res.json({
      ok: true,
      table: tableName,
      requested_limit: limit,
      count: rows.length,
      rows,
    });
  } catch (e) {
    console.error('[naboto-appsheet-read]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
