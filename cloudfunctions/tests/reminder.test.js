'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryRepository } = require('./memory-repository');
const { createReminder, loadConfig, allowedTrigger, beijingParts, deliveryId, recordId, subscriptionId, settingsId } = require('../xuyixia-remind/service');
const NOW = '2026-10-26T13:00:00.000Z';
function config() {
  return loadConfig({ REMINDER_ENABLED: 'true', TEMPLATE_ID: 'approved', TEMPLATE_FIELDS_JSON: '{"thing1":"title","time2":"time","thing3":"summary","number4":"count"}' });
}
async function seed(repo, id, overrides = {}) {
  const task = { id, owner: 'alice', name: id, type: 'douyin', enabled: true, time: '21:00', deletedAt: null, ...overrides };
  await repo.put('tasks', id, task);
  return task;
}
async function subscribe(repo, owner = 'alice', count = 10) {
  await repo.put('subscriptions', subscriptionId(owner, 'approved'), { owner, templateId: 'approved', signalCount: count, lastResult: 'accept' });
}

test('forged timer input cannot bypass a client OPENID; trusted console timer shape is accepted', () => {
  const event = { Type: 'Timer', TriggerName: 'xuyixiaEveryMinute' };
  assert.equal(allowedTrigger(event, { OPENID: 'attacker' }), false);
  assert.equal(allowedTrigger(event, { SOURCE: 'wx_client' }), false);
  assert.equal(allowedTrigger({ ...event, TriggerName: 'other' }, {}), false);
  assert.equal(allowedTrigger(event, {}), true);
});

test('configuration fails closed and field mappings must match supported template types', async () => {
  const repo = memoryRepository();
  await seed(repo, 'one');
  await subscribe(repo);
  let sent = 0;
  const run = createReminder({ repo, config: loadConfig({}, {}), send: async () => { sent++; }, now: () => new Date(NOW) });
  assert.equal((await run()).configured, false);
  assert.equal(sent, 0);
  assert.throws(() => loadConfig({ TEMPLATE_FIELDS_JSON: '{"time2":"summary"}' }));
  assert.throws(() => loadConfig({ TEMPLATE_FIELDS_JSON: 'invalid' }));
});

test('same-owner same-time tasks merge, while completed, paused, deleted and future tasks are skipped', async () => {
  const repo = memoryRepository();
  await seed(repo, 'one', { name: '🔥'.repeat(30) });
  await seed(repo, 'two', { type: 'weibo' });
  await seed(repo, 'completed');
  await repo.put('records', recordId('alice', 'completed', '2026-10-26'), { owner: 'alice', completedAt: NOW });
  await seed(repo, 'paused', { enabled: false });
  await seed(repo, 'deleted', { deletedAt: NOW });
  await seed(repo, 'future', { time: '21:01' });
  await seed(repo, 'late', { time: '20:00' });
  await seed(repo, 'bobtask', { owner: 'bob' });
  await subscribe(repo);
  await subscribe(repo, 'bob');
  const messages = [];
  const run = createReminder({ repo, config: config(), now: () => new Date(NOW), send: async msg => { messages.push(msg); return { errCode: 0 }; } });
  const result = await run();
  assert.equal(result.submitted, 2);
  assert.equal(messages.length, 2);
  const alice = messages.find(message => message.touser === 'alice');
  assert.equal(alice.data.number4.value, '2');
  assert.equal(Array.from(alice.data.thing3.value).length, 20);
  assert.equal(alice.data.time2.value, '2026-10-26 21:00');
  const delivery = await repo.get('deliveries', deliveryId('alice', '2026-10-26', '21:00'));
  assert.equal(delivery.status, 'submitted');
  assert.deepEqual(delivery.taskIds, ['one', 'two']);
  assert.equal((await run()).submitted, 0);
});

test('overlapping timer invocations atomically claim one delivery and consume one signal', async () => {
  const repo = memoryRepository();
  await seed(repo, 'one');
  await subscribe(repo, 'alice', 3);
  let sent = 0;
  const run = createReminder({ repo, config: config(), now: () => new Date(NOW), send: async () => { sent++; return { errCode: 0 }; } });
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.equal(results.reduce((sum, value) => sum + value.submitted, 0), 1);
  assert.equal(sent, 1);
  assert.equal((await repo.get('subscriptions', subscriptionId('alice', 'approved'))).signalCount, 2);
});

test('uncertain external failure is terminal and never retried by the next timer', async () => {
  const repo = memoryRepository();
  await seed(repo, 'one');
  await subscribe(repo);
  let sent = 0;
  const run = createReminder({ repo, config: config(), now: () => new Date(NOW), send: async () => { sent++; throw new Error('socket reset after request'); } });
  assert.equal((await run()).unknown, 1);
  assert.equal((await run()).submitted, 0);
  assert.equal(sent, 1);
  assert.equal((await repo.get('deliveries', deliveryId('alice', '2026-10-26', '21:00'))).status, 'unknown');
});

test('missing evidence and active clear do not send; a pause after claim is checked again', async () => {
  const repo = memoryRepository();
  await seed(repo, 'one');
  let sent = 0;
  const run = createReminder({ repo, config: config(), now: () => new Date(NOW), send: async () => { sent++; return { errCode: 0 }; } });
  assert.equal((await run()).submitted, 0);
  await subscribe(repo);
  await repo.put('settings', settingsId('alice'), { owner: 'alice', clearing: true });
  assert.equal((await run()).submitted, 0);
  await repo.remove('settings', settingsId('alice'));
  const atomic = repo.atomic.bind(repo);
  let claims = 0;
  repo.atomic = async callback => {
    const result = await atomic(callback);
    if (++claims === 1) {
      const task = await repo.get('tasks', 'one');
      await repo.put('tasks', 'one', { ...task, enabled: false });
    }
    return result;
  };
  assert.equal((await run()).submitted, 0);
  assert.equal(sent, 0);
  assert.equal((await repo.get('deliveries', deliveryId('alice', '2026-10-26', '21:00'))).status, 'suppressed');
});

test('Beijing midnight starts a new day and does not revive yesterday late reminders', async () => {
  assert.deepEqual(beijingParts(new Date('2026-10-26T16:00:00Z')), { date: '2026-10-27', time: '00:00', minute: 0 });
  const repo = memoryRepository();
  await seed(repo, 'yesterday', { time: '23:59' });
  await seed(repo, 'today', { time: '00:00' });
  await subscribe(repo);
  const messages = [];
  const run = createReminder({ repo, config: config(), now: () => new Date('2026-10-26T16:00:00Z'), send: async msg => { messages.push(msg); return { errCode: 0 }; } });
  assert.equal((await run()).submitted, 1);
  assert.equal(messages[0].data.time2.value, '2026-10-27 00:00');
});
