'use strict';
const { createLocalStore } = require('./store');
const { validateTask } = require('../utils/domain');
const clone = value => JSON.parse(JSON.stringify(value));
function error(message, code) { return Object.assign(new Error(message), { code }); }

function createOfflineStore(api, config, remote) {
  let scope, cache, initPromise, lastFetched = 0, blockedIdentity = false, networkAvailable = true, serial = Promise.resolve();
  const status = { mode: 'cloud', verified: false, pendingCount: 0, offline: false, conflict: false, lastError: '', lastSyncedAt: '' };
  const storageKey = () => 'xuyixia.cloud-cache.v1.' + scope;
  const queueId = () => 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
  const taskId = () => 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 14);
  const run = fn => { const next = serial.then(fn, fn); serial = next.catch(() => {}); return next; };
  function persist() {
    api.setStorageSync(storageKey(), cache);
    status.pendingCount = cache.queue.length;
    status.lastSyncedAt = cache.lastSyncedAt || '';
  }
  async function snapshot() {
    const value = await remote.call('getSnapshot');
    if (value.scope !== scope) { status.conflict = true; blockedIdentity = true; throw error('数据空间已变化，请重新联网加载，本机草稿不会自动上传', 'SESSION_CHANGED'); }
    const previous = cache;
    cache = { version: 1, scope, revision: value.revision, state: value.state, queue: [], lastSyncedAt: new Date().toISOString() };
    try { persist(); } catch (_) { cache = previous; throw error('本机快照保存失败，原草稿已保留', 'CACHE_WRITE_FAILED'); }
    lastFetched = Date.now(); status.offline = false; status.lastError = ''; status.conflict = false;
  }
  async function initialize() {
    if (scope && cache && !blockedIdentity) return;
    if (!networkAvailable) throw error('请先联网验证当前身份，再使用离线缓存', 'CLOUD_UNAVAILABLE');
    if (!initPromise) initPromise = (async () => {
      // 每次冷启动先在线验证当前用户；不把上一账号的缓存当作离线登录。
      const session = await remote.call('getSession');
      if (!session || typeof session.scope !== 'string' || !/^[a-f0-9]{64}$/.test(session.scope)) throw error('身份验证结果异常', 'SESSION_INVALID');
      scope = session.scope;
      blockedIdentity = false;
      const stored = api.getStorageSync(storageKey());
      if (stored && (stored.version !== 1 || stored.scope !== scope || !Array.isArray(stored.queue) || !stored.state)) throw error('离线草稿格式异常，请联系维护者，不会覆盖原数据', 'CACHE_INVALID');
      cache = stored ? clone(stored) : null;
      status.verified = true;
      if (!cache) await snapshot(); else { status.pendingCount = cache.queue.length; status.lastSyncedAt = cache.lastSyncedAt || ''; }
    })().finally(() => { initPromise = null; });
    await initPromise;
  }
  async function flush() {
    if (!networkAvailable) { status.offline = true; status.pendingCount = cache.queue.length; status.lastError = '网络已断开，修改等待同步'; return false; }
    while (cache.queue.length) {
      const mutation = cache.queue[0];
      try {
        const receipt = await remote.call('commitOffline', { scope, expectedRevision: cache.revision, mutation });
        const previous = cache;
        cache = { ...cache, revision: receipt.revision, queue: cache.queue.slice(1) };
        try { persist(); } catch (_) { cache = previous; throw error('同步回执未能保存在本机，将安全重试', 'CACHE_WRITE_FAILED'); }
        status.offline = false; status.lastError = ''; status.conflict = false;
      } catch (problem) {
        status.offline = problem.code === 'CLOUD_UNAVAILABLE';
        status.conflict = !status.offline;
        status.lastError = problem.message;
        if (problem.code === 'SESSION_CHANGED') blockedIdentity = true;
        status.pendingCount = cache.queue.length;
        return false;
      }
    }
    return true;
  }
  async function ready(force) {
    await initialize();
    if (cache.queue.length && !(await flush())) { if (blockedIdentity) throw error(status.lastError, 'SESSION_CHANGED'); return; }
    if (!networkAvailable) { status.offline = true; return; }
    if (!force && Date.now() - lastFetched < 1500) return;
    try { await snapshot(); }
    catch (problem) {
      if (problem.code === 'SESSION_CHANGED') { blockedIdentity = true; status.conflict = true; }
      if (problem.code !== 'CLOUD_UNAVAILABLE') throw problem;
      status.offline = true; status.lastError = '当前显示本机缓存';
    }
  }
  function local(state) {
    return createLocalStore({
      getStorageSync: () => clone(state.value),
      setStorageSync: (_, value) => { state.value = clone(value); },
      removeStorageSync: () => {}
    });
  }
  function read(method, args) {
    return run(async () => { await ready(false); return local({ value: cache.state })[method](...args); });
  }
  function mutate(kind, parameters, localArgs) {
    return run(async () => {
      await ready(false);
      if (cache.queue.length >= 500) throw error('待同步操作较多，请先联网同步', 'QUEUE_LIMIT');
      const draft = { value: clone(cache.state) };
      const result = await local(draft)[kind](...localArgs);
      const previous = cache;
      cache = { ...cache, state: draft.value, queue: [...cache.queue, { id: queueId(), kind, ...parameters }] };
      try { persist(); } catch (_) { cache = previous; throw error('离线保存失败，请检查本机空间', 'CACHE_WRITE_FAILED'); }
      const synced = await flush();
      // 即使微信网络恢复，客户端也仅在收到云端回执后移出队列。
      return result && typeof result === 'object' ? { ...result, _pendingSync: !synced } : result;
    });
  }
  const store = {
    listTasks: params => read('listTasks', [params]), getTask: id => read('getTask', [id]),
    listRecords: params => read('listRecords', [params]), getSettings: () => read('getSettings', []),
    async saveTask(input) {
      const checked = validateTask(input);
      if (!checked.valid) throw error(Object.values(checked.errors)[0], 'INVALID_INPUT');
      const creating = !checked.value.id, value = { ...checked.value, id: checked.value.id || taskId() };
      // 本地仓库创建时分配同一ID，云端重试不会产生第二个任务。
      if (creating) return run(async () => {
        await ready(false);
        if (cache.queue.length >= 500) throw error('请先同步现有操作', 'QUEUE_LIMIT');
        const draft = clone(cache.state);
        const localStore = createLocalStore({ getStorageSync: () => draft, setStorageSync: (_, state) => Object.assign(draft, state) }, { idFactory: () => value.id });
        const result = await localStore.saveTask({ ...value, id: undefined });
        const previous = cache;
        cache = { ...cache, state: draft, queue: [...cache.queue, { id: queueId(), kind: 'saveTask', creating: true, task: value }] };
        try { persist(); } catch (_) { cache = previous; throw error('离线保存失败，请检查本机空间', 'CACHE_WRITE_FAILED'); }
        const synced = await flush(); return { ...result, _pendingSync: !synced };
      });
      return mutate('saveTask', { task: value, creating: false }, [value]);
    },
    toggleTask: (taskId, enabled) => mutate('toggleTask', { taskId, enabled }, [taskId, enabled]),
    deleteTask: taskId => mutate('deleteTask', { taskId }, [taskId]),
    setCompletion: (taskId, date, completed) => mutate('setCompletion', { taskId, date, completed }, [taskId, date, completed]),
    saveSettings: patch => mutate('saveSettings', { patch }, [patch]),
    getSyncStatus: () => ({ ...status }),
    setNetworkAvailable(value) { networkAvailable = !!value; status.offline = !value; },
    syncNow: () => run(async () => { networkAvailable = true; await ready(true); return { ...status }; }),
    discardPending: () => run(async () => {
      await initialize();
      // 必须先取得有效快照；断网时不丢弃本机草稿。
      await snapshot(); return { ...status };
    }),
    registerSubscription: (...args) => remote.registerSubscription(...args),
    shared: (action, payload) => run(async () => { await initialize(); if (!networkAvailable) throw error('共同任务需要联网核对双方状态', 'CLOUD_UNAVAILABLE'); return remote.call(action, payload); }),
    clearAll: () => run(async () => {
      await initialize(); await remote.clearAll(); api.removeStorageSync(storageKey()); scope = null; cache = null; lastFetched = 0;
      Object.assign(status, { verified: false, pendingCount: 0, offline: false, conflict: false, lastError: '', lastSyncedAt: '' });
      return null;
    })
  };
  return store;
}
module.exports = { createOfflineStore };
