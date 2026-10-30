'use strict';
const { todayKey, TIME_RE } = require('./domain');

function timing(task, date, now) {
  if (task.completed || date !== todayKey(now) || !TIME_RE.test(task.time)) return { timingLabel: '', timingKind: '' };
  const remaining = Date.parse(date + 'T' + task.time + ':00+08:00') - now;
  if (remaining <= 0) return { timingLabel: '已到你设置的处理时间', timingKind: 'due' };
  if (remaining <= 30 * 60000) return { timingLabel: '还有' + Math.ceil(remaining / 60000) + '分钟到处理时间', timingKind: 'soon' };
  return { timingLabel: '尚未到处理时间', timingKind: 'later' };
}

function todayView(tasks, { date, query = '', filter = 'all', statusFilter = 'pending', now = Date.now() }) {
  const keyword = query.trim().toLowerCase();
  const matching = tasks.filter(task => (filter === 'all' || task.type === filter) && (!keyword || `${task.name} ${task.note || ''}`.toLowerCase().includes(keyword)));
  const pending = matching.filter(task => !task.completed).length;
  const confirmed = matching.length - pending;
  const visibleTasks = matching.filter(task => statusFilter === 'all' || (statusFilter === 'confirmed' ? task.completed : !task.completed))
    .map(task => ({ ...task, ...timing(task, date, now) }));
  let emptyTitle = '没有匹配的任务', emptyText = '换个关键词，或重置筛选后查看。', emptyAction = 'reset';
  if (matching.length && statusFilter === 'pending' && !pending) {
    emptyTitle = '这个范围的任务都已确认'; emptyText = '可以查看已确认任务，也可以撤销刚才的操作。'; emptyAction = 'confirmed';
  } else if (matching.length && statusFilter === 'confirmed' && !confirmed) {
    emptyTitle = '这里还没有已确认任务'; emptyText = '处理对应平台的任务后，再回来手动确认。'; emptyAction = 'pending';
  } else if (!keyword && filter !== 'all') {
    emptyTitle = '这个平台今天没有安排'; emptyText = '切换平台，或到全部任务查看其他日期的计划。';
  }
  return { visibleTasks, statusCounts: { all: matching.length, pending, confirmed }, emptyTitle, emptyText, emptyAction };
}

module.exports = { timing, todayView };
