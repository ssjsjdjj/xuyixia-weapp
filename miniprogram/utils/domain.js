'use strict';
const policy = require('./policy');

const DAY = 24 * 60 * 60 * 1000;
const OFFSET = 8 * 60 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function todayKey(now) {
  const millis = now === undefined ? Date.now() : new Date(now).getTime();
  if (!Number.isFinite(millis)) throw new Error('日期无效');
  return new Date(millis + OFFSET).toISOString().slice(0, 10);
}

function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function shiftDate(value, delta) {
  if (!isDateKey(value) || !Number.isInteger(delta)) throw new Error('日期无效');
  return new Date(Date.parse(value + 'T00:00:00.000Z') + delta * DAY).toISOString().slice(0, 10);
}

function formatDateLabel(value) {
  if (!isDateKey(value)) return '';
  return Number(value.slice(5, 7)) + '月' + Number(value.slice(8, 10)) + '日';
}

function platformLabel(type) {
  return type === 'weibo' ? '微博打卡' : '抖音续火花';
}

function validateTask(input) {
  const source = input || {};
  const value = {
    type: source.type,
    name: typeof source.name === 'string' ? source.name.trim() : '',
    time: typeof source.time === 'string' ? source.time : '',
    note: typeof source.note === 'string' ? source.note.trim() : '',
    greeting: typeof source.greeting === 'string' ? source.greeting.trim() : '',
    enabled: source.enabled === undefined ? true : source.enabled
  };
  if (source.id) value.id = source.id;
  const errors = {};
  if (!['douyin', 'weibo'].includes(value.type)) errors.type = '请选择任务类型';
  if (!value.name || Array.from(value.name).length > 40) errors.name = '请输入1—40字的对象名称';
  if (!TIME_RE.test(value.time)) errors.time = '请选择有效的提醒时间';
  if (Array.from(value.note).length > 200) errors.note = '备注最多200字';
  if (Array.from(value.greeting).length > 200) errors.greeting = '招呼文案最多200字';
  if (typeof value.enabled !== 'boolean') errors.enabled = '任务启用状态无效';
  try { Object.assign(value, policy.taskOptions(source)); } catch (error) { errors.repeat = error.message; }
  return { valid: Object.keys(errors).length === 0, errors, value };
}

function decorateTasks(tasks, records, date) {
  const day = date || todayKey();
  const completed = new Set((records || []).filter(r => r.date === day).map(r => r.taskId));
  return (tasks || []).map(task => {
    const done = completed.has(task.id);
    return Object.assign({}, task, {
      completed: done,
      statusLabel: done ? '已确认完成' : task.enabled ? '待确认' : '已暂停',
      platformLabel: platformLabel(task.type),
      avatar: task.type === 'weibo' ? '微' : Array.from(task.name || '友')[0],
      repeatLabel: policy.repeatLabel(task), scheduledToday: policy.isTaskOnDate(task, day)
    });
  }).sort((a, b) => Number(a.completed) - Number(b.completed) || Number(!!b.pinned) - Number(!!a.pinned) || a.time.localeCompare(b.time) || a.name.localeCompare(b.name));
}

function nextReminderSeconds(time, now) {
  if (!TIME_RE.test(time)) throw new Error('提醒时间无效');
  const millis = now === undefined ? Date.now() : new Date(now).getTime();
  const day = todayKey(millis);
  let at = Date.parse(day + 'T' + time + ':00+08:00');
  if (at <= millis) at += DAY;
  return Math.floor(at / 1000);
}

function calendarSlots(task, now) {
  const millis = now === undefined ? Date.now() : new Date(now).getTime();
  if (!TIME_RE.test(task.time)) throw new Error('提醒时间无效');
  const options = policy.taskOptions(task);
  const base = options.resumeOn && options.resumeOn > todayKey(millis) ? options.resumeOn : todayKey(millis);
  const days = options.repeat === 'daily' ? [null] : options.repeat === 'weekdays' ? [1,2,3,4,5] : options.weekDays;
  return days.map(weekday => {
    for (let offset = 0; offset < 8; offset++) {
      const day = shiftDate(base, offset), value = Date.parse(day + 'T' + task.time + ':00+08:00');
      if (value > millis && (weekday === null || (new Date(day + 'T00:00:00Z').getUTCDay() || 7) === weekday)) return { key: weekday === null ? 'daily' : 'week-' + weekday, startTime: Math.floor(value / 1000), repeatInterval: weekday === null ? 'day' : 'week' };
    }
    throw new Error('无法计算下一次日历日期');
  });
}

module.exports = { todayKey, isDateKey, shiftDate, formatDateLabel, platformLabel, validateTask, decorateTasks, nextReminderSeconds, calendarSlots, TIME_RE, ...policy };
