const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi } = require('../cloudfunctions/xuyixia-api/service');
const { memoryRepository } = require('../cloudfunctions/tests/memory-repository');
const { createCloudStore } = require('../miniprogram/services/store');
const { createOfflineStore } = require('../miniprogram/services/offline');
function setup() {
  const repo = memoryRepository(), service = createApi({ repo }), memory = new Map();
  let online = true, owner = 'alice', dropReceipt = false, failReceiptWrite = false, failWrite = false;
  const wx = {
    getStorageSync: key => memory.has(key) ? structuredClone(memory.get(key)) : '',
    setStorageSync: (key, value) => { if (failWrite) { failWrite=false; throw new Error('quota'); } memory.set(key, structuredClone(value)); }, removeStorageSync: key => memory.delete(key),
    cloud: { callFunction: async ({ data }) => {
      if (!online) throw new Error('offline');
      const result = await service(data, { OPENID: owner });
      if (data.action === 'commitOffline' && failReceiptWrite) { failReceiptWrite=false; failWrite=true; }
      if (data.action === 'commitOffline' && dropReceipt) { dropReceipt = false; throw new Error('response lost'); }
      return { result };
    } }
  };
  const config = { cloudEnabled: true }, remote = createCloudStore(wx, config);
  return { repo, remote, memory, make: () => createOfflineStore(wx, config, remote), offline: () => { online = false; }, online: () => { online = true; }, setOwner: value => { owner = value; }, loseReceipt: () => { dropReceipt = true; }, failReceiptWrite: () => { failReceiptWrite=true; } };
}
const input = name => ({ type: 'douyin', name, time: '21:00' });
test('已验证身份后离线可读写；恢复网络按顺序上传且不丢编辑', async () => {
  const h = setup(), store = h.make(); await store.listTasks();
  h.offline(); const task = await store.saveTask(input('草稿'));
  assert.equal(task._pendingSync, true); assert.equal(store.getSyncStatus().pendingCount, 1);
  await store.saveTask({ ...task, name: '修改后的草稿' });
  assert.equal((await store.listTasks())[0].name, '修改后的草稿');
  h.online(); await store.syncNow();
  assert.equal(store.getSyncStatus().pendingCount, 0);
  assert.equal((await h.remote.listTasks())[0].name, '修改后的草稿');
});
test('外部提交成功但回执丢失，重试不会重复创建', async () => {
  const h = setup(), store = h.make(); await store.listTasks(); h.loseReceipt();
  const task = await store.saveTask(input('回执丢失'));
  assert.equal(task._pendingSync, true); assert.equal((await h.repo.query('tasks')).length, 1);
  await store.syncNow(); assert.equal((await h.repo.query('tasks')).length, 1); assert.equal(store.getSyncStatus().pendingCount, 0);
});
test('冷启动离线不能冒用上一个账号缓存；切换账号不会显示别人的数据', async () => {
  const h = setup(), first = h.make(); await first.listTasks(); await first.saveTask(input('alice私有'));
  h.offline(); await assert.rejects(h.make().listTasks(), { code: 'CLOUD_UNAVAILABLE' });
  h.online(); h.setOwner('bob'); assert.deepEqual(await h.make().listTasks(), []);
});
test('并发设备修改产生冲突，本机草稿保留；断网不能丢弃草稿', async () => {
  const h = setup(), store = h.make(); await store.listTasks();
  await h.remote.saveTask(input('其他设备新增'));
  const result = await store.saveTask(input('本机草稿'));
  assert.equal(result._pendingSync, true); assert.equal(store.getSyncStatus().conflict, true);
  assert.equal((await h.repo.query('tasks')).length, 1);
  h.offline(); await assert.rejects(store.discardPending()); assert.equal(store.getSyncStatus().pendingCount, 1);
  h.online(); await store.discardPending(); assert.equal(store.getSyncStatus().pendingCount, 0);
  assert.equal((await store.listTasks())[0].name, '其他设备新增');
});
test('其他设备清空后旧离线队列不能重建已清空的数据', async () => {
  const h = setup(), store = h.make(); await store.listTasks(); h.offline(); await store.saveTask(input('旧草稿'));
  h.online(); await h.remote.clearAll(); await h.remote.call('getSession');
  await assert.rejects(store.syncNow(), { code: 'SESSION_CHANGED' }); assert.equal(store.getSyncStatus().conflict, true); assert.equal((await h.repo.query('tasks')).length, 0);
  assert.deepEqual(await h.make().listTasks(), []);
});

test('云端成功后本机保存回执失败，保留队列以幂等方式重试',async()=>{
  const h=setup(),store=h.make();await store.listTasks();h.failReceiptWrite();
  const result=await store.saveTask(input('回执存储失败'));assert.equal(result._pendingSync,true);assert.equal(store.getSyncStatus().pendingCount,1);
  await store.syncNow();assert.equal(store.getSyncStatus().pendingCount,0);assert.equal((await h.repo.query('tasks')).length,1);
});

test('系统明确通知断网后仍可保存并显示待同步，联网后再上传',async()=>{
  const h=setup(),store=h.make();await store.listTasks();store.setNetworkAvailable(false);
  const result=await store.saveTask(input('离线快速保存'));assert.equal(result._pendingSync,true);assert.equal((await h.repo.query('tasks')).length,0);
  store.setNetworkAvailable(true);await store.syncNow();assert.equal((await h.repo.query('tasks')).length,1);
});
