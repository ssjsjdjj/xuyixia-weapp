'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi, settingsId, subscriptionId, recordId } = require('../xuyixia-api/service');
const { memoryRepository } = require('./memory-repository');

function setup() {
  const repo = memoryRepository();
  let tick = new Date('2026-10-26T13:00:00.000Z');
  let sequence = 0;
  const api = createApi({ repo, now: () => tick, createId: () => `task_${++sequence}`, templateId: 'approved-template' });
  const call = async (action, payload = {}, owner = 'alice') => api({ action, payload }, { OPENID: owner });
  const save = async (overrides = {}, owner) => {
    const response = await call('saveTask', { task: { type: 'douyin', name: '小林', time: '21:00', ...overrides } }, owner);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  return { repo, api, call, save, advance: stamp => { tick = new Date(stamp); } };
}

test('platform identity isolates every task operation and no ownership field can be supplied', async () => {
  const { api, call, save } = setup();
  const task = await save();
  assert.equal((await api({ action: 'listTasks' }, {})).error.code, 'UNAUTHENTICATED');
  assert.equal((await call('saveTask', { task: { owner: 'bob' } })).error.code, 'INVALID_INPUT');
  assert.deepEqual((await call('listTasks', {}, 'bob')).data, []);
  for (const [action, payload] of [
    ['getTask', { id: task.id }], ['toggleTask', { id: task.id, enabled: false }],
    ['deleteTask', { id: task.id }], ['saveTask', { task }],
    ['setCompletion', { taskId: task.id, date: '2026-10-26', completed: true }]
  ]) {
    assert.equal((await call(action, payload, 'bob')).error.code, 'NOT_FOUND', action);
  }
  assert.equal((await call('getTask', { id: task.id })).data.name, '小林');
});

test('validation handles Unicode names, legal calendar dates, strict times and future dates', async () => {
  const { call, save, advance } = setup();
  const task = await save({ name: ` ${'🔥'.repeat(40)} ` });
  assert.equal(Array.from(task.name).length, 40);
  for (const patch of [{ name: '🔥'.repeat(41) }, { time: '24:00' }, { time: '9:00' }, { enabled: 'true' }, { type: 'other' }, { note: 'x'.repeat(201) }]) {
    assert.equal((await call('saveTask', { task: { ...task, ...patch } })).error.code, 'INVALID_INPUT');
  }
  assert.equal((await call('setCompletion', { taskId: task.id, date: '2026-02-30', completed: true })).error.code, 'INVALID_INPUT');
  assert.equal((await call('setCompletion', { taskId: task.id, date: '2026-10-27', completed: true })).error.code, 'INVALID_INPUT');
  advance('2026-10-26T16:00:00.000Z'); // UTC 16:00 is Beijing's next day.
  assert.equal((await call('setCompletion', { taskId: task.id, date: '2026-10-27', completed: true })).ok, true);
});

test('paused tasks are hidden by default and task updates preserve the server creation timestamp', async () => {
  const { call, save, advance } = setup();
  const task = await save();
  advance('2026-10-26T13:02:00.000Z');
  const updated = (await call('saveTask', { task: { ...task, name: '新昵称', createdAt: 'forged', updatedAt: 'forged' } })).data;
  assert.equal(updated.createdAt, task.createdAt);
  assert.equal(updated.updatedAt, '2026-10-26T13:02:00.000Z');
  await call('toggleTask', { id: task.id, enabled: false });
  assert.equal((await call('listTasks')).data.length, 0);
  assert.equal((await call('listTasks', { includePaused: true })).data.length, 1);
});

test('simultaneous completion is idempotent and history is a durable name/type snapshot', async () => {
  const { call, save, repo, advance } = setup();
  const task = await save();
  const payload = { taskId: task.id, date: '2026-10-26', completed: true };
  const results = await Promise.all(Array.from({ length: 12 }, () => call('setCompletion', payload)));
  assert.ok(results.every(result => result.ok));
  assert.equal((await repo.query('records')).length, 1);
  advance('2026-10-26T13:05:00.000Z');
  const repeated = await call('setCompletion', payload);
  assert.equal(repeated.data.completedAt, results[0].data.completedAt);
  await call('saveTask', { task: { ...task, name: '已改名' } });
  await call('deleteTask', { id: task.id });
  const history = (await call('listRecords')).data;
  assert.equal(history[0].name, '小林');
  assert.equal((await call('getTask', { id: task.id })).error.code, 'NOT_FOUND');
  assert.equal((await call('setCompletion', payload)).error.code, 'NOT_FOUND');
  assert.equal((await call('setCompletion', { ...payload, completed: false })).data, null);
  assert.equal((await repo.query('records')).length, 0);
});

test('subscription evidence is template-restricted and clearAll only clears the caller', async () => {
  const { call, save, repo } = setup();
  const alice = await save();
  const bob = await save({}, 'bob');
  await call('setCompletion', { taskId: alice.id, date: '2026-10-26', completed: true });
  await call('setCompletion', { taskId: bob.id, date: '2026-10-26', completed: true }, 'bob');
  assert.equal((await call('registerSubscription', { templateId: 'wrong', result: 'accept' })).error.code, 'TEMPLATE_NOT_CONFIGURED');
  const result = await call('registerSubscription', { templateId: 'approved-template', result: 'accept' });
  assert.equal(result.data.hintOnly, true);
  assert.equal((await repo.get('subscriptions', subscriptionId('alice', 'approved-template'))).signalCount, 1);
  await call('clearAll');
  assert.deepEqual((await call('listTasks', { includePaused: true })).data, []);
  assert.deepEqual((await call('listRecords')).data, []);
  assert.equal((await call('listTasks', {}, 'bob')).data[0].id, bob.id);
  assert.equal((await call('listRecords', {}, 'bob')).data.length, 1);
  assert.equal(await repo.get('settings', settingsId('alice')), null);
  assert.equal(await repo.get('records', recordId('alice', alice.id, '2026-10-26')), null);
});

test('interrupted clear blocks writes and can be resumed after its lease expires', async () => {
  const { call, save, repo, advance } = setup();
  await save();
  await repo.put('settings', settingsId('alice'), { owner: 'alice', clearing: true, clearToken: 'old', clearStartedAt: '2026-10-26T13:00:00.000Z' });
  assert.equal((await call('toggleTask', { id: 'task_1', enabled: false })).error.code, 'DATA_CLEARING');
  assert.equal((await call('clearAll')).error.code, 'DATA_CLEARING');
  advance('2026-10-26T13:05:01.000Z');
  assert.equal((await call('clearAll')).ok, true);
  assert.equal((await repo.query('tasks')).length, 0);
});
