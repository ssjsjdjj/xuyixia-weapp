'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRepository } = require('../xuyixia-api/repository');

test('SDK adapter preserves direct transaction results including application result properties', async () => {
  const db = { runTransaction: async callback => callback({}) };
  const repo = createRepository(db);
  assert.deepEqual(await repo.atomic(async () => ({ registered: true, result: 'accept' })), { registered: true, result: 'accept' });
  assert.equal(await repo.atomic(async () => false), false);
});

test('SDK adapter propagates validation errors instead of converting them into success', async () => {
  const db = { runTransaction: async callback => callback({}) };
  const repo = createRepository(db);
  await assert.rejects(repo.atomic(async () => { throw Object.assign(new Error('denied'), { code: 'NOT_FOUND' }); }), { code: 'NOT_FOUND' });
});
