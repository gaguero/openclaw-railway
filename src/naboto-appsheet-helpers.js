/**
 * Pure helpers for AppSheet read-only integration (testable).
 */

export const DEFAULT_APPSHEET_HOST = 'www.appsheet.com';
export const MAX_APPSHEET_ROWS = 100;
export const TABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9_ ]{0,79}$/;

/** AppSheet Filter() first arg: bare id or quoted name if spaces */
export function tableRefForSelector(tableName) {
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(tableName)) {
    return tableName;
  }
  const safe = String(tableName).replace(/"/g, '');
  return `"${safe}"`;
}

export function parseAppsheetAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function appsheetEnvConfigured(env = process.env) {
  return Boolean(
    env.APPSHEET_APP_ID?.trim() && env.APPSHEET_ACCESS_KEY?.trim(),
  );
}

/**
 * @param {string} tableName
 * @param {number} limit
 * @param {string} [locale]
 */
export function buildAppsheetFindBody(tableName, limit, locale = 'en-US') {
  const ref = tableRefForSelector(tableName);
  const selector = `Top(OrderBy(Filter(${ref}, true), [_RowNumber], false), ${limit})`;
  return {
    Action: 'Find',
    Properties: {
      Locale: locale,
      Selector: selector,
    },
    Rows: [],
  };
}

export function clampAppsheetLimit(raw, fallback = 25) {
  const n = parseInt(String(raw ?? ''), 10);
  const v = Number.isNaN(n) ? fallback : n;
  return Math.min(MAX_APPSHEET_ROWS, Math.max(1, v));
}
