import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { nabotoProposalsPostHandler } from '../src/naboto-proposals.js';

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

describe('nabotoProposalsPostHandler', () => {
  const prev = process.env.NABOTO_INGEST_SECRET;

  after(() => {
    if (prev === undefined) delete process.env.NABOTO_INGEST_SECRET;
    else process.env.NABOTO_INGEST_SECRET = prev;
  });

  it('returns 503 when secret unset', async () => {
    delete process.env.NABOTO_INGEST_SECRET;
    const res = mockRes();
    await nabotoProposalsPostHandler({ headers: {}, body: {} }, res);
    assert.strictEqual(res.statusCode, 503);
  });

  it('returns 401 when bearer wrong', async () => {
    process.env.NABOTO_INGEST_SECRET = 's';
    process.env.DATABASE_URL = 'postgres://a:b@localhost:5432/x';
    const res = mockRes();
    await nabotoProposalsPostHandler({ headers: { authorization: 'Bearer x' }, body: {} }, res);
    assert.strictEqual(res.statusCode, 401);
  });
});
