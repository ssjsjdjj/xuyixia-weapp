const { test } = require('node:test');
const assert = require('node:assert/strict');
const { todayKey, shiftDate, validateTask, decorateTasks, nextReminderSeconds, isDateKey } = require('../miniprogram/utils/domain');

test('跨北京时间零点生成每日记录键，不依赖电脑时区', () => {
  assert.equal(todayKey('2026-10-26T15:59:59Z'), '2026-10-26');
  assert.equal(todayKey('2026-10-26T16:00:00Z'), '2026-10-27');
  assert.equal(shiftDate('2028-03-01', -1), '2028-02-29');
  assert.equal(isDateKey('2026-02-30'), false);
});

test('创建任务拒绝空名称、越界时间和超长文案', () => {
  const good = { type: 'douyin', name: '  小宇  ', time: '21:00' };
  assert.equal(validateTask(good).value.name, '小宇');
  assert.equal(validateTask(good).value.enabled, true);
  for (const bad of [{ name: '' }, { time: '24:00' }, { type: 'unknown' }, { note: '字'.repeat(201) }, { enabled: 'false' }]) {
    assert.equal(validateTask({ ...good, ...bad }).valid, false);
  }
});

test('确认只影响对应任务与日期，未完成优先排序', () => {
  const tasks = [
    { id: 'a', type: 'douyin', name: '小宇', time: '20:00', enabled: true },
    { id: 'b', type: 'weibo', name: '超话', time: '21:00', enabled: true }
  ];
  const records = [{ taskId: 'a', date: '2026-10-26' }];
  const today = decorateTasks(tasks, records, '2026-10-26');
  assert.deepEqual(today.map(t => t.id), ['b', 'a']);
  assert.equal(today[1].statusLabel, '已确认完成');
  assert.equal(decorateTasks(tasks, records, '2026-10-27')[0].completed, false);
});

test('日历已过时点顺延到次日，未过时点保留当天', () => {
  const now = '2026-10-26T13:00:00Z';
  assert.equal(new Date(nextReminderSeconds('20:30', now) * 1000).toISOString(), '2026-10-27T12:30:00.000Z');
  assert.equal(new Date(nextReminderSeconds('21:30', now) * 1000).toISOString(), '2026-10-26T13:30:00.000Z');
});
