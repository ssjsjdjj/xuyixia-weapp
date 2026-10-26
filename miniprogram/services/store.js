'use strict';

const { validateTask, isDateKey, todayKey, DEFAULT_SETTINGS, settingsPatch } = require('../utils/domain');
const STORAGE_KEY = 'xuyixia.state.v1';
const CALENDAR_KEY = 'xuyixia.calendars.v1';
const clone = value => JSON.parse(JSON.stringify(value));

function fail(message, code) {
  const error = new Error(message);
  error.code = code || 'INVALID_INPUT';
  throw error;
}

function createLocalStore(api, options) {
  const now = options && options.now || (() => new Date().toISOString());
  const idFactory = options && options.idFactory || (() => 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12));
  function read() {
    const stored = api.getStorageSync(STORAGE_KEY);
    if (stored === '' || stored === undefined || stored === null) return { version: 1, tasks: [], records: [], settings: { ...DEFAULT_SETTINGS } };
    if (!stored || stored.version !== 1 || !Array.isArray(stored.tasks) || !Array.isArray(stored.records) || !stored.settings) {
      fail('本机数据格式异常，请先备份后联系维护者', 'STORAGE_INVALID');
    }
    return clone(stored);
  }
  function write(state) {
    try { api.setStorageSync(STORAGE_KEY, state); }
    catch (_) { fail('本机保存失败，请检查剩余存储空间后重试', 'STORAGE_WRITE_FAILED'); }
  }
  function taskIn(state, id) { return state.tasks.find(t => t.id === id && !t.deletedAt); }
  return {
    getSyncStatus: () => ({ mode: 'local', verified: true, pendingCount: 0, offline: false, conflict: false }),
    async syncNow() { return this.getSyncStatus(); },
    async shared() { fail('共同任务需要配置云开发并联网使用', 'CLOUD_REQUIRED'); },
    async listTasks(params) {
      const includePaused = params && params.includePaused;
      return read().tasks.filter(t => !t.deletedAt && (includePaused || t.enabled));
    },
    async getTask(id) { return taskIn(read(), id) || null; },
    async saveTask(input) {
      const check = validateTask(input);
      if (!check.valid) fail(Object.values(check.errors)[0]);
      const state = read(), value = check.value;
      const existing = value.id ? taskIn(state, value.id) : null;
      if (value.id && !existing) fail('任务不存在或已删除', 'NOT_FOUND');
      const task = Object.assign({}, value, {
        id: existing ? existing.id : idFactory(),
        createdAt: existing ? existing.createdAt : now(),
        updatedAt: now()
      });
      if (existing) state.tasks[state.tasks.findIndex(t => t.id === task.id)] = task;
      else state.tasks.push(task);
      write(state);
      return clone(task);
    },
    async toggleTask(id, enabled) {
      if (typeof enabled !== 'boolean') fail('任务状态无效');
      const state = read(), task = taskIn(state, id);
      if (!task) fail('任务不存在或已删除', 'NOT_FOUND');
      task.enabled = enabled;
      if (enabled) task.resumeOn = '';
      task.updatedAt = now();
      write(state);
      return clone(task);
    },
    async deleteTask(id) {
      const state = read(), task = taskIn(state, id);
      if (!task) return null;
      task.deletedAt = now();
      task.enabled = false;
      task.updatedAt = now();
      write(state);
      return null;
    },
    async listRecords(params) {
      const p = params || {};
      ['date', 'from', 'to'].forEach(key => { if (p[key] && !isDateKey(p[key])) fail('记录日期无效'); });
      return read().records.filter(r => (!p.date || r.date === p.date) && (!p.from || r.date >= p.from) && (!p.to || r.date <= p.to)).sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    },
    async setCompletion(taskId, date, completed) {
      if (!isDateKey(date) || date > todayKey(now())) fail('不能设置未来的完成记录');
      if (typeof completed !== 'boolean') fail('完成状态无效');
      const state = read(), task = taskIn(state, taskId);
      if (completed && !task) fail('任务不存在或已删除', 'NOT_FOUND');
      const existing = state.records.find(r => r.taskId === taskId && r.date === date);
      if (!completed) state.records = state.records.filter(r => !(r.taskId === taskId && r.date === date));
      else if (!existing) state.records.push({ taskId, date, name: task.name, type: task.type, completedAt: now() });
      write(state);
      return completed ? clone(existing || state.records.find(r => r.taskId === taskId && r.date === date)) : null;
    },
    async getSettings() { return Object.assign({}, DEFAULT_SETTINGS, read().settings); },
    async saveSettings(patch) {
      const state = read();
      state.settings = settingsPatch(patch, state.settings);
      write(state);
      return clone(state.settings);
    },
    async clearAll() {
      api.removeStorageSync(STORAGE_KEY);
      api.removeStorageSync(CALENDAR_KEY);
      return null;
    }
  };
}

function createCloudStore(api, config) {
  async function call(action, payload) {
    if (!config.cloudEnabled) fail('请先配置云开发环境，或将 storageMode 设为 local', 'CLOUD_UNCONFIGURED');
    let response;
    try { response = await api.cloud.callFunction({ name: config.apiFunctionName || 'xuyixia-api', data: { action, payload: payload || {} } }); }
    catch (_) { fail('云服务暂时不可用，请检查网络与云函数部署', 'CLOUD_UNAVAILABLE'); }
    const result = response && response.result;
    if (!result || !result.ok) fail(result && result.error && result.error.message || '云服务返回异常', result && result.error && result.error.code || 'CLOUD_ERROR');
    return result.data;
  }
  return {
    call,
    listTasks: params => call('listTasks', params),
    getTask: id => call('getTask', { id }),
    saveTask: task => call('saveTask', { task }),
    toggleTask: (id, enabled) => call('toggleTask', { id, enabled }),
    deleteTask: id => call('deleteTask', { id }),
    listRecords: params => call('listRecords', params),
    setCompletion: (taskId, date, completed) => call('setCompletion', { taskId, date, completed }),
    getSettings: () => call('getSettings'),
    saveSettings: patch => call('saveSettings', { patch }),
    clearAll: async () => { const result = await call('clearAll'); api.removeStorageSync(CALENDAR_KEY); return result; },
    registerSubscription: (templateId, result) => call('registerSubscription', { templateId, result })
  };
}

function createStore(api, config) {
  return config.storageMode === 'cloud' ? require('./offline').createOfflineStore(api, config, createCloudStore(api, config)) : createLocalStore(api);
}

module.exports = { createStore, createLocalStore, createCloudStore, STORAGE_KEY, CALENDAR_KEY };
