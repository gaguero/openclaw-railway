import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  tableRefForSelector,
  parseAppsheetAllowlist,
  appsheetEnvConfigured,
  buildAppsheetFindBody,
  clampAppsheetLimit,
  MAX_APPSHEET_ROWS,
} from '../src/naboto-appsheet-helpers.js';

describe('naboto-appsheet-helpers', () => {
  it('tableRefForSelector leaves simple identifiers bare', () => {
    assert.strictEqual(tableRefForSelector('Guests'), 'Guests');
    assert.strictEqual(tableRefForSelector('Room_Division'), 'Room_Division');
  });

  it('tableRefForSelector quotes names with spaces', () => {
    assert.strictEqual(tableRefForSelector('Room Service'), '"Room Service"');
    assert.strictEqual(tableRefForSelector('A B'), '"A B"');
  });

  it('tableRefForSelector strips double quotes from input', () => {
    assert.strictEqual(tableRefForSelector('Evil"'), '"Evil"');
  });

  it('parseAppsheetAllowlist splits and trims', () => {
    assert.deepStrictEqual(parseAppsheetAllowlist('A, B ,'), ['A', 'B']);
    assert.deepStrictEqual(parseAppsheetAllowlist(''), []);
  });

  it('appsheetEnvConfigured requires both id and key', () => {
    assert.strictEqual(
      appsheetEnvConfigured({ APPSHEET_APP_ID: 'x', APPSHEET_ACCESS_KEY: '' }),
      false,
    );
    assert.strictEqual(
      appsheetEnvConfigured({ APPSHEET_APP_ID: '  ', APPSHEET_ACCESS_KEY: 'k' }),
      false,
    );
    assert.strictEqual(
      appsheetEnvConfigured({ APPSHEET_APP_ID: 'app', APPSHEET_ACCESS_KEY: 'V2-secret' }),
      true,
    );
  });

  it('buildAppsheetFindBody uses Find + Selector in Properties', () => {
    const b = buildAppsheetFindBody('Guests', 10, 'es-CR');
    assert.strictEqual(b.Action, 'Find');
    assert.strictEqual(b.Properties.Locale, 'es-CR');
    assert.ok(b.Properties.Selector.includes('Filter(Guests, true)'));
    assert.ok(b.Properties.Selector.includes(', 10)'));
    assert.deepStrictEqual(b.Rows, []);
  });

  it('buildAppsheetFindBody quotes table in Filter when needed', () => {
    const b = buildAppsheetFindBody('X Y', 3, 'en-US');
    assert.ok(b.Properties.Selector.includes('Filter("X Y", true)'));
  });

  it('clampAppsheetLimit respects bounds', () => {
    assert.strictEqual(clampAppsheetLimit('5', 25), 5);
    assert.strictEqual(clampAppsheetLimit('999', 25), MAX_APPSHEET_ROWS);
    assert.strictEqual(clampAppsheetLimit('0', 25), 1);
    assert.strictEqual(clampAppsheetLimit('bad', 25), 25);
  });
});
