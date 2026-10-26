'use strict';
// 由 scripts/sync-policy.js 同步到两个独立部署的云函数。
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_SETTINGS = { defaultReminderTime: '21:00', reminderMode: 'perTime', digestTime: '21:00', quietEnabled: false, quietStart: '23:00', quietEnd: '08:00' };
function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value; }
function taskOptions(input) {
  const source = input || {};
  const repeat = source.repeat === undefined ? 'daily' : source.repeat;
  const pinned = source.pinned === undefined ? false : source.pinned;
  const resumeOn = source.resumeOn || '';
  if (!['daily', 'weekdays', 'custom'].includes(repeat)) throw new Error('重复周期无效');
  if (typeof pinned !== 'boolean') throw new Error('置顶状态无效');
  if (resumeOn && !validDate(resumeOn)) throw new Error('恢复日期无效');
  const days = source.weekDays === undefined ? [] : source.weekDays;
  if (!Array.isArray(days) || days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error('请选择有效的星期');
  const weekDays = repeat === 'custom' ? [...new Set(days)].sort((a, b) => a - b) : [];
  if (repeat === 'custom' && !weekDays.length) throw new Error('自选周期至少选择一天');
  return { repeat, weekDays, pinned, resumeOn };
}
function isTaskOnDate(task, day) {
  if (!task.enabled || task.deletedAt || (task.resumeOn && day < task.resumeOn)) return false;
  const weekday = new Date(day + 'T00:00:00Z').getUTCDay() || 7;
  return task.repeat === 'weekdays' ? weekday <= 5 : task.repeat === 'custom' ? (task.weekDays || []).includes(weekday) : true;
}
function repeatLabel(task) {
  const label = task.repeat === 'weekdays' ? '周一至周五' : task.repeat === 'custom' ? '每周' + (task.weekDays || []).map(day => '一二三四五六日'[day - 1]).join('、') : '每天';
  return task.resumeOn ? label + ' · ' + task.resumeOn + '起恢复' : label;
}
function minuteOf(time) { return Number(time.slice(0, 2)) * 60 + Number(time.slice(3)); }
function isQuiet(time, settings) {
  const s = Object.assign({}, DEFAULT_SETTINGS, settings);
  if (!s.quietEnabled) return false;
  const value = minuteOf(time), start = minuteOf(s.quietStart), end = minuteOf(s.quietEnd);
  return start < end ? value >= start && value < end : value >= start || value < end;
}
function settingsPatch(patch, previous) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key))) throw new Error('提醒设置包含不支持的字段');
  const result = Object.assign({}, DEFAULT_SETTINGS, previous, patch);
  for (const key of ['defaultReminderTime', 'digestTime', 'quietStart', 'quietEnd']) if (typeof result[key] !== 'string' || !TIME_RE.test(result[key])) throw new Error('请选择有效的提醒时间');
  if (!['perTime', 'digest'].includes(result.reminderMode) || typeof result.quietEnabled !== 'boolean') throw new Error('提醒方式无效');
  if (result.quietEnabled && result.quietStart === result.quietEnd) throw new Error('免打扰开始和结束时间不能相同');
  if (result.reminderMode === 'digest' && isQuiet(result.digestTime, result)) throw new Error('汇总时间位于免打扰时段，请调整时间');
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, result[key]]));
}
module.exports = { DEFAULT_SETTINGS, taskOptions, isTaskOnDate, repeatLabel, isQuiet, settingsPatch, validDate };
