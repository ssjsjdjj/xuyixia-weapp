'use strict';

const { createHash } = require('node:crypto');
const { isTaskOnDate, isQuiet, DEFAULT_SETTINGS } = require('./policy');
const TRIGGER_NAME = 'xuyixiaEveryMinute';
function key(...parts) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function settingsId(owner) { return key('settings', owner); }
function subscriptionId(owner, templateId) { return key('subscription', owner, templateId); }
function recordId(owner, taskId, day) { return key('completion', owner, taskId, day); }
function deliveryId(owner, day, time) { return key('delivery', owner, day, time); }
function beijingParts(now) {
  const iso = new Date(now.valueOf() + 8 * 3600000).toISOString();
  const time = iso.slice(11, 16);
  return { date: iso.slice(0, 10), time, minute: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) };
}
function allowedTrigger(event, wxContext = {}) {
  // OPENID is immutable platform context. Never trust event.OPENID or event.Type alone.
  if (wxContext.OPENID || /wx_client|client|http/i.test(String(wxContext.SOURCE || ''))) return false;
  return Boolean(event && event.Type === 'Timer' && event.TriggerName === TRIGGER_NAME);
}
function loadConfig(env = {}, file = {}) {
  let fields = file.templateFields || {};
  if (env.TEMPLATE_FIELDS_JSON) {
    try { fields = JSON.parse(env.TEMPLATE_FIELDS_JSON); } catch { throw new Error('Invalid TEMPLATE_FIELDS_JSON'); }
  }
  const config = {
    enabled: env.REMINDER_ENABLED === undefined ? file.enabled === true : env.REMINDER_ENABLED === 'true',
    templateId: env.TEMPLATE_ID || file.templateId || '',
    templateFields: fields,
    page: file.page || 'pages/today/index',
    miniprogramState: env.MINIPROGRAM_STATE || file.miniprogramState || 'developer',
    maxDelayMinutes: Number(env.REMINDER_MAX_DELAY_MINUTES || file.maxDelayMinutes || 15)
  };
  if (!Number.isInteger(config.maxDelayMinutes) || config.maxDelayMinutes < 0 || config.maxDelayMinutes > 1440) throw new Error('Invalid maxDelayMinutes');
  if (!['developer', 'trial', 'formal'].includes(config.miniprogramState)) throw new Error('Invalid miniprogramState');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid templateFields');
  const validBindings = {
    thing: ['title', 'summary', 'name', 'platform'], time: ['time'], date: ['date'], number: ['count'], phrase: ['status']
  };
  for (const [field, binding] of Object.entries(fields)) {
    const match = /^(thing|time|date|number|phrase)\d+$/.exec(field);
    if (!match || !validBindings[match[1]].includes(binding)) throw new Error('Invalid template field binding');
  }
  config.ready = config.enabled && Boolean(config.templateId.trim()) && Object.keys(fields).length > 0;
  return config;
}
function dueGroups(tasks, parts, maxDelayMinutes, settingsByOwner = {}) {
  const groups = new Map();
  for (const task of tasks) {
    if (!task.owner || !isTaskOnDate(task, parts.date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(task.time)) continue;
    const settings = { ...DEFAULT_SETTINGS, ...(settingsByOwner[task.owner] || {}) };
    const slot = settings.reminderMode === 'digest' ? settings.digestTime : task.time;
    if (isQuiet(slot, settings) || isQuiet(parts.time, settings)) continue;
    const minute = Number(slot.slice(0, 2)) * 60 + Number(slot.slice(3));
    const delay = parts.minute - minute;
    if (delay < 0 || delay > maxDelayMinutes) continue;
    const groupKey = deliveryId(task.owner, parts.date, slot);
    if (!groups.has(groupKey)) groups.set(groupKey, { id: groupKey, owner: task.owner, time: slot, date: parts.date, mode: settings.reminderMode, tasks: [] });
    groups.get(groupKey).tasks.push(task);
  }
  return [...groups.values()];
}
function shorten(value, max) { return Array.from(value).slice(0, max).join(''); }
function buildMessage(group, tasks, config) {
  const values = {
    title: '今日待办提醒',
    summary: tasks.map(task => task.name).join('、'),
    name: tasks[0].name,
    platform: [...new Set(tasks.map(task => task.type === 'douyin' ? '抖音续火花' : '微博打卡'))].join('、'),
    time: `${group.date} ${group.time}`, date: group.date, count: String(tasks.length), status: '待确认'
  };
  const data = {};
  for (const [field, binding] of Object.entries(config.templateFields)) {
    const max = field.startsWith('thing') ? 20 : field.startsWith('phrase') ? 5 : 32;
    data[field] = { value: shorten(values[binding], max) };
  }
  return {
    touser: group.owner, templateId: config.templateId, page: config.page,
    miniprogramState: config.miniprogramState, lang: 'zh_CN', data
  };
}

function createReminder({ repo, config, send, now = () => new Date() }) {
  async function pending(group) {
    const settings = await repo.get('settings', settingsId(group.owner));
    if (settings && settings.clearing) return [];
    const preferences = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    if (isQuiet(beijingParts(now()).time, preferences) || isQuiet(group.time, preferences) || preferences.reminderMode !== group.mode || (group.mode === 'digest' && preferences.digestTime !== group.time)) return [];
    const tasks = [];
    for (const candidate of group.tasks) {
      const current = await repo.get('tasks', candidate.id);
      if (!current || current.owner !== group.owner || !isTaskOnDate(current, group.date) || (group.mode !== 'digest' && current.time !== group.time)) continue;
      const completion = await repo.get('records', recordId(group.owner, current.id, group.date));
      if (!completion) tasks.push(current);
    }
    return tasks;
  }
  async function mark(group, status, extra = {}) {
    await repo.atomic(async tx => {
      const current = await tx.get('deliveries', group.id);
      // clearAll may have removed the ledger while the external request was in flight.
      // Never recreate user data after the owner has cleared it.
      if (current) await tx.put('deliveries', group.id, { ...current, status, ...extra, updatedAt: now().toISOString() });
    });
  }
  return async function run() {
    const summary = { configured: Boolean(config.ready), groups: 0, submitted: 0, skipped: 0, unknown: 0, failed: 0 };
    if (!config.ready) return summary;
    const parts = beijingParts(now());
    const allTasks = await repo.query('tasks', { enabled: true });
    const settingsByOwner = {};
    for (const owner of new Set(allTasks.map(task => task.owner))) settingsByOwner[owner] = await repo.get('settings', settingsId(owner));
    const groups = dueGroups(allTasks, parts, config.maxDelayMinutes, settingsByOwner);
    summary.groups = groups.length;
    for (const group of groups) {
      if (!(await pending(group)).length) { summary.skipped++; continue; }
      const stamp = now().toISOString();
      // A single transaction reserves the group and one advisory subscription signal.
      // Existing ledger entries are terminal, including uncertain outcomes and old claims.
      const claimed = await repo.atomic(async tx => {
        const settings = await tx.get('settings', settingsId(group.owner));
        if (settings && settings.clearing) return false;
        if (await tx.get('deliveries', group.id)) return false;
        const subId = subscriptionId(group.owner, config.templateId);
        const sub = await tx.get('subscriptions', subId);
        if (!sub || sub.lastResult !== 'accept' || sub.signalCount <= 0) return false;
        await tx.put('deliveries', group.id, {
          owner: group.owner, date: group.date, time: group.time, taskIds: group.tasks.map(task => task.id),
          status: 'claimed', claimedAt: stamp, updatedAt: stamp, templateId: config.templateId
        });
        await tx.put('subscriptions', subId, { ...sub, signalCount: sub.signalCount - 1, updatedAt: stamp });
        return true;
      });
      if (!claimed) { summary.skipped++; continue; }
      // Re-read pause/delete/completion just before the external side effect.
      const tasks = await pending(group);
      const currentParts = beijingParts(now());
      if (!tasks.length || currentParts.date !== group.date) {
        await mark(group, 'suppressed');
        summary.skipped++;
        continue;
      }
      try {
        const response = await send(buildMessage(group, tasks, config));
        const code = response && (response.errCode === undefined ? response.errcode : response.errCode);
        if (code === undefined) {
          await mark(group, 'unknown', { errorCode: 'MISSING_RESPONSE_CODE' });
          summary.unknown++;
        } else if (Number(code) !== 0) {
          await mark(group, 'failed', { errorCode: String(code) });
          summary.failed++;
        } else {
          // Success only means WeChat accepted the request, never read/finished.
          await mark(group, 'submitted', { submittedAt: now().toISOString(), taskIds: tasks.map(task => task.id) });
          summary.submitted++;
        }
      } catch (error) {
        const code = error && (error.errCode === undefined ? error.errcode : error.errCode);
        const definiteRejection = ['40003', '40037', '41030', '43101', '47003'].includes(String(code));
        const status = definiteRejection ? 'failed' : 'unknown';
        await mark(group, status, { errorCode: String(code || 'TRANSPORT_UNCERTAIN') });
        summary[status]++;
      }
    }
    return summary;
  };
}

module.exports = { createReminder, loadConfig, allowedTrigger, beijingParts, dueGroups, buildMessage, deliveryId, settingsId, subscriptionId, recordId };
