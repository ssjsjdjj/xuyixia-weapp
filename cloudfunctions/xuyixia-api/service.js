'use strict';

const { createHash, randomBytes } = require('node:crypto');

const policy = require('./policy');
const DEFAULT_SETTINGS = policy.DEFAULT_SETTINGS;
const TASK_FIELDS = ['id', 'type', 'name', 'time', 'note', 'greeting', 'enabled', 'createdAt', 'updatedAt', 'repeat', 'weekDays', 'pinned', 'resumeOn'];
const FORBIDDEN = new Set(['owner', 'ownerId', 'openid', 'openId', 'OPENID', '_openid', '_id']);
class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new ApiError(code, message); }
function object(value, label = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', `${label}格式不正确`);
  return value;
}
function noIdentity(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) fail('INVALID_INPUT', '不能在请求中指定用户身份或数据库标识');
    noIdentity(child);
  }
}
function text(value, max, label, required = false) {
  if (typeof value !== 'string') fail('INVALID_INPUT', `${label}必须是文字`);
  const result = value.trim();
  if ((required && !result) || Array.from(result).length > max) fail('INVALID_INPUT', `${label}需为${required ? '1—' : '0—'}${max}个字符`);
  return result;
}
function time(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('INVALID_INPUT', '时间需为 HH:mm');
  return value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') fail('INVALID_INPUT', `${label}必须是布尔值`);
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT', '任务标识不正确');
  return value;
}
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_INPUT', '日期需为 YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) fail('INVALID_INPUT', '日期不存在');
  return value;
}
function beijingDate(now) { return new Date(now.valueOf() + 8 * 3600000).toISOString().slice(0, 10); }
function key(...parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function settingsId(owner) { return key('settings', owner); }
function subscriptionId(owner, templateId) { return key('subscription', owner, templateId); }
function recordId(owner, taskId, day) { return key('completion', owner, taskId, day); }
function publicTask(task) { return { ...Object.fromEntries(TASK_FIELDS.map(field => [field, task[field]])), ...policy.taskOptions(task) }; }
function publicRecord(record) {
  return { taskId: record.taskId, date: record.date, name: record.name, type: record.type, completedAt: record.completedAt };
}
function ownTask(task, owner, allowDeleted = false) {
  if (!task || task.owner !== owner || (!allowDeleted && task.deletedAt)) fail('NOT_FOUND', '任务不存在');
  return task;
}
async function guard(handle, owner) {
  const settings = await handle.get('settings', settingsId(owner));
  if (settings && settings.clearing) fail('DATA_CLEARING', '数据正在清除，请稍后重试');
  return settings;
}

function createApi({ repo, now = () => new Date(), createId = () => randomBytes(16).toString('hex'), templateId = '' }) {
  const advanced = require('./advanced').createAdvanced({ repo, now, createId, helpers: { fail, key, settingsId, recordId, guard, ownTask, publicTask, publicRecord, id, date, time, text, boolean, object } });
  return async function api(event, context) {
    try {
      const owner = context && context.OPENID;
      if (typeof owner !== 'string' || !owner) fail('UNAUTHENTICATED', '请从微信小程序访问');
      object(event, '请求');
      noIdentity(event);
      const payload = event.payload === undefined ? {} : object(event.payload);
      const extended = await advanced.handle(event.action, payload, owner);
      if (extended.handled) return { ok: true, data: extended.data };
      const stamp = now().toISOString();
      let data;
      switch (event.action) {
        case 'listTasks': {
          await guard(repo, owner);
          const includePaused = payload.includePaused === undefined ? false : boolean(payload.includePaused, '包含暂停任务');
          data = (await repo.query('tasks', { owner })).filter(task => !task.deletedAt && (includePaused || task.enabled))
            .sort((a, b) => a.time.localeCompare(b.time) || a.createdAt.localeCompare(b.createdAt)).map(publicTask);
          break;
        }
        case 'getTask': {
          await guard(repo, owner);
          data = publicTask(ownTask(await repo.get('tasks', id(payload.id)), owner));
          break;
        }
        case 'saveTask': {
          const input = object(payload.task, '任务');
          if (Object.keys(input).some(field => !TASK_FIELDS.includes(field))) fail('INVALID_INPUT', '任务包含不支持的字段');
          if (!['douyin', 'weibo'].includes(input.type)) fail('INVALID_INPUT', '请选择抖音或微博');
          const normalized = {
            type: input.type, name: text(input.name, 40, '名称', true), time: time(input.time),
            note: text(input.note === undefined ? '' : input.note, 200, '备注'),
            greeting: text(input.greeting === undefined ? '' : input.greeting, 200, '招呼文案'),
            enabled: input.enabled === undefined ? true : boolean(input.enabled, '启用状态')
          };
          try { Object.assign(normalized, policy.taskOptions(input)); } catch (error) { fail('INVALID_INPUT', error.message); }
          const taskId = input.id ? id(input.id) : createId();
          data = await repo.atomic(async tx => {
            const settings = await guard(tx, owner);
            const old = await tx.get('tasks', taskId);
            if (input.id) ownTask(old, owner);
            else if (old) fail('CONFLICT', '标识冲突，请重试');
            // This owner document also serializes create/clear and enforces the task cap.
            const taskCount = settings && settings.taskCount || 0;
            if (!input.id && taskCount >= 100) fail('TASK_LIMIT', '最多可创建 100 个任务');
            const task = { ...normalized, id: taskId, owner, createdAt: old ? old.createdAt : stamp, updatedAt: stamp, deletedAt: null };
            await tx.put('tasks', taskId, task);
            await tx.put('settings', settingsId(owner), {
              owner, ...DEFAULT_SETTINGS, ...(settings || {}), taskCount: taskCount + (input.id ? 0 : 1), updatedAt: stamp, revision: (settings && settings.revision || 0) + 1
            });
            return publicTask(task);
          });
          break;
        }
        case 'toggleTask':
        case 'deleteTask': {
          const taskId = id(payload.id);
          const enabled = event.action === 'toggleTask' ? boolean(payload.enabled, '启用状态') : false;
          data = await repo.atomic(async tx => {
            const settings = await guard(tx, owner);
            const task = ownTask(await tx.get('tasks', taskId), owner);
            const deleting = event.action === 'deleteTask';
            const changed = { ...task, enabled, ...(enabled ? { resumeOn: '' } : {}), updatedAt: stamp, ...(deleting ? { deletedAt: stamp } : {}) };
            await tx.put('tasks', taskId, changed);
            await tx.put('settings', settingsId(owner), {
              owner, ...DEFAULT_SETTINGS, ...(settings || {}), updatedAt: stamp,
              taskCount: Math.max(0, (settings && settings.taskCount || 0) - (deleting ? 1 : 0)), revision: (settings && settings.revision || 0) + 1
            });
            return deleting ? { deleted: true } : publicTask(changed);
          });
          break;
        }
        case 'listRecords': {
          await guard(repo, owner);
          const day = payload.date === undefined ? null : date(payload.date);
          const from = payload.from === undefined ? null : date(payload.from);
          const to = payload.to === undefined ? null : date(payload.to);
          if (from && to && from > to) fail('INVALID_INPUT', '开始日期不能晚于结束日期');
          data = (await repo.query('records', { owner })).filter(record => (!day || record.date === day) && (!from || record.date >= from) && (!to || record.date <= to))
            .sort((a, b) => b.date.localeCompare(a.date) || b.completedAt.localeCompare(a.completedAt)).map(publicRecord);
          break;
        }
        case 'setCompletion': {
          const taskId = id(payload.taskId);
          const day = date(payload.date);
          const completed = boolean(payload.completed, '完成状态');
          if (day > beijingDate(now())) fail('INVALID_INPUT', '不能确认未来日期');
          data = await repo.atomic(async tx => {
            const settings = await guard(tx, owner);
            // A deleted task can have an old record undone; it cannot receive new confirmations.
            const task = ownTask(await tx.get('tasks', taskId), owner, !completed);
            const recordKey = recordId(owner, taskId, day);
            const existing = await tx.get('records', recordKey);
            if (completed) {
              if (existing) return publicRecord(existing);
              const record = { owner, taskId, date: day, name: task.name, type: task.type, completedAt: stamp };
              await tx.put('records', recordKey, record);
              await tx.put('settings', settingsId(owner), { owner, ...DEFAULT_SETTINGS, ...(settings || {}), revision: (settings && settings.revision || 0) + 1 });
              return publicRecord(record);
            }
            if (existing) await tx.remove('records', recordKey);
            if (existing) await tx.put('settings', settingsId(owner), { owner, ...DEFAULT_SETTINGS, ...(settings || {}), revision: (settings && settings.revision || 0) + 1 });
            return null;
          });
          break;
        }
        case 'getSettings': {
          const settings = await guard(repo, owner);
          data = policy.settingsPatch({}, settings || {});
          break;
        }
        case 'saveSettings': {
          const patch = object(payload.patch, '设置');
          data = await repo.atomic(async tx => {
            const previous = await guard(tx, owner);
            let settings; try { settings = policy.settingsPatch(patch, previous); } catch (error) { fail('INVALID_INPUT', error.message); }
            await tx.put('settings', settingsId(owner), { owner, ...(previous || {}), ...settings, updatedAt: stamp, revision: (previous && previous.revision || 0) + 1 });
            return settings;
          });
          break;
        }
        case 'registerSubscription': {
          if (!templateId || payload.templateId !== templateId) fail('TEMPLATE_NOT_CONFIGURED', '云端订阅消息模板尚未配置或不匹配');
          if (!['accept', 'reject', 'ban', 'filter'].includes(payload.result)) fail('INVALID_INPUT', '订阅结果不正确');
          data = await repo.atomic(async tx => {
            await guard(tx, owner);
            const subId = subscriptionId(owner, templateId);
            const previous = await tx.get('subscriptions', subId);
            // This is client-reported evidence, not a verified WeChat subscription balance.
            const signalCount = payload.result === 'accept' ? Math.min(100, (previous && previous.signalCount || 0) + 1) : 0;
            await tx.put('subscriptions', subId, { owner, templateId, signalCount, lastResult: payload.result, updatedAt: stamp });
            return { registered: true, result: payload.result, hintOnly: true };
          });
          break;
        }
        case 'clearAll': {
          // Persistent marker makes interrupted clears safely resumable and stops new writes/sends.
          const clearToken = createId();
          await repo.atomic(async tx => {
            const previous = await tx.get('settings', settingsId(owner));
            if (previous && previous.clearing && now().valueOf() - Date.parse(previous.clearStartedAt) < 300000) {
              fail('DATA_CLEARING', '数据正在清除；如上次中断，请在五分钟后重试');
            }
            await tx.put('settings', settingsId(owner), {
              owner, ...DEFAULT_SETTINGS, ...(previous || {}), clearing: true,
              clearToken, clearStartedAt: stamp, updatedAt: stamp
            });
          });
          await advanced.cleanupJoints(owner);
          for (const collection of ['tasks', 'records', 'subscriptions', 'deliveries', 'mutations']) {
            const documents = await repo.query(collection, { owner });
            for (const document of documents) {
              const marker = await repo.get('settings', settingsId(owner));
              if (!marker || marker.clearToken !== clearToken) fail('DATA_CLEARING', '清除工作已交由其他请求继续');
              await repo.remove(collection, document._id || document.id);
            }
          }
          await repo.atomic(async tx => {
            const marker = await tx.get('settings', settingsId(owner));
            if (!marker || marker.clearToken !== clearToken) fail('DATA_CLEARING', '清除工作已交由其他请求继续');
            await tx.remove('settings', settingsId(owner));
          });
          data = { cleared: true };
          break;
        }
        default: fail('UNKNOWN_ACTION', '不支持的操作');
      }
      return { ok: true, data };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, error: { code: error.code, message: error.message } };
      // Do not return platform internals, OPENID, stack traces or message content.
      console.error('xuyixia-api failure', { code: error && (error.code || error.errCode) || 'INTERNAL' });
      return { ok: false, error: { code: 'INTERNAL', message: '服务暂时不可用，请稍后重试' } };
    }
  };
}

module.exports = { createApi, ApiError, DEFAULT_SETTINGS, beijingDate, key, settingsId, subscriptionId, recordId };
