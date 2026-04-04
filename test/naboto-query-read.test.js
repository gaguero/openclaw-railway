import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import {
  nabotoQueryIndexHandler,
  nabotoQueryToursHandler,
  nabotoQueryGuestsHandler,
} from '../src/naboto-query-read.js';

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(o) {
      this.body = o;
      return this;
    },
  };
  return res;
}

describe('naboto-query-read', () => {
  const prevDb = process.env.DATABASE_URL;

  after(() => {
    if (prevDb === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = prevDb;
    }
  });

  it('index lists operational query paths including tours and guests', async () => {
    const res = mockRes();
    await nabotoQueryIndexHandler({}, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body?.ok, true);
    const paths = (res.body?.endpoints || []).map((e) => e.path);
    for (const p of [
      'arrivals',
      'tours',
      'massages',
      'transfers',
      'other-hotels',
      'special-requests',
      'romantic-dinners',
      'guests',
    ]) {
      assert.ok(paths.includes(p), `missing path ${p}`);
    }
  });

  it('guests returns 503 when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL;
    const req = { query: { guest_id: '1' } };
    const res = mockRes();
    await nabotoQueryGuestsHandler(req, res);
    assert.strictEqual(res.statusCode, 503);
  });

  it('guests returns 400 without guest_id and short q', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:65432/naboto_query_test';
    const req = { query: { q: 'x' } };
    const res = mockRes();
    await nabotoQueryGuestsHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body?.error || '', /guest_id|q/i);
  });

  it('tours returns 400 when to_day < from_day (before DB query)', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:65432/naboto_query_test';
    const req = { query: { from_day: '2', to_day: '0' } };
    const res = mockRes();
    await nabotoQueryToursHandler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body?.error || '', /to_day/);
  });
});
