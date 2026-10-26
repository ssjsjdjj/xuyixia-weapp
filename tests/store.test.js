const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalStore, createCloudStore, STORAGE_KEY } = require('../miniprogram/services/store');

function setup() {
  const memory = new Map(); let sequence = 0;
  const api = {
    getStorageSync: key => memory.has(key) ? structuredClone(memory.get(key)) : '',
    setStorageSync: (key, value) => memory.set(key, structuredClone(value)),
    removeStorageSync: key => memory.delete(key)
  };
  return { memory, api, store: createLocalStore(api, { now: () => '2026-10-26T10:00:00.000Z', idFactory: () => 'id-' + (++sequence) }) };
}
const input = { type: 'douyin', name: '小宇', time: '21:00' };

test('任务与确认记录持久化；重复确认幂等且可撤销', async () => {
  const { store, api } = setup();
  const task = await store.saveTask(input);
  await Promise.all([store.setCompletion(task.id, '2026-10-26', true), store.setCompletion(task.id, '2026-10-26', true)]);
  assert.equal((await store.listRecords({ date: '2026-10-26' })).length, 1);
  assert.equal((await createLocalStore(api).getTask(task.id)).name, '小宇');
  await store.setCompletion(task.id, '2026-10-26', false);
  assert.deepEqual(await store.listRecords({}), []);
});

test('暂停不删除历史；删除任务保留记录快照并允许撤销', async () => {
  const { store } = setup();
  const task = await store.saveTask(input);
  await store.setCompletion(task.id, '2026-10-26', true);
  await store.toggleTask(task.id, false);
  assert.equal((await store.listTasks()).length, 0);
  assert.equal((await store.listTasks({ includePaused: true })).length, 1);
  await store.deleteTask(task.id);
  assert.equal(await store.getTask(task.id), null);
  assert.equal((await store.listRecords({}))[0].name, '小宇');
  await store.setCompletion(task.id, '2026-10-26', false);
  assert.equal((await store.listRecords({})).length, 0);
});

test('不允许未来完成和异常数据被静默覆盖', async () => {
  const { store, memory } = setup();
  const task = await store.saveTask(input);
  await assert.rejects(store.setCompletion(task.id, '2026-10-27', true), /未来/);
  memory.set(STORAGE_KEY, { version: 99 });
  await assert.rejects(store.listTasks(), /格式异常/);
  assert.equal(memory.get(STORAGE_KEY).version, 99);
  await store.clearAll();
  assert.deepEqual(await store.listTasks(), []);
});

test('本地磁盘写入失败必须传达给调用者', async () => {
  const { api } = setup(); api.setStorageSync = () => { throw new Error('quota'); };
  await assert.rejects(createLocalStore(api).saveTask(input), /保存失败/);
});

test('云端代理按契约传参且不能把云故障退回本地成功', async () => {
  const calls = [];
  const api = { cloud: { callFunction: async call => { calls.push(call); return { result: { ok: true, data: { id: 'a' } } }; } } };
  const store = createCloudStore(api, { cloudEnabled: true });
  await store.setCompletion('a', '2026-10-26', true);
  assert.deepEqual(calls[0].data, { action: 'setCompletion', payload: { taskId: 'a', date: '2026-10-26', completed: true } });
  api.cloud.callFunction = async () => { throw new Error('offline'); };
  await assert.rejects(store.listTasks(), /云服务暂时不可用/);
});
