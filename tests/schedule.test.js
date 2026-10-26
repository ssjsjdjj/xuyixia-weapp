const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateTask, isTaskOnDate, decorateTasks, settingsPatch, isQuiet, calendarSlots } = require('../miniprogram/utils/domain');
const task = { id: 'a', type: 'douyin', name: '好友', enabled: true, time: '21:00' };
test('周一至周五、自选星期和临时暂停在日期边界一致', () => {
  assert.equal(isTaskOnDate({ ...task, repeat: 'weekdays' }, '2026-10-26'), true);
  assert.equal(isTaskOnDate({ ...task, repeat: 'weekdays' }, '2026-11-01'), false);
  assert.equal(isTaskOnDate({ ...task, repeat: 'custom', weekDays: [7] }, '2026-11-01'), true);
  assert.equal(isTaskOnDate({ ...task, resumeOn: '2026-11-02' }, '2026-11-01'), false);
  assert.equal(isTaskOnDate({ ...task, resumeOn: '2026-11-02' }, '2026-11-02'), true);
  assert.equal(validateTask({ ...task, repeat: 'custom', weekDays: [] }).valid, false);
  assert.equal(validateTask({ ...task, repeat: 'custom', weekDays: [0,8] }).valid, false);
});
test('置顶先于时间排序，已确认仍排在未确认之后', () => {
  const sorted = decorateTasks([{ ...task, id: 'a', time: '08:00' }, { ...task, id: 'b', time: '22:00', pinned: true }, { ...task, id: 'c', time: '07:00', pinned: true }], [{ taskId: 'c', date: '2026-10-26' }], '2026-10-26');
  assert.deepEqual(sorted.map(item => item.id), ['b','a','c']);
});
test('跨午夜免打扰包含开始不含结束，禁止汇总时间落在其中', () => {
  const settings = settingsPatch({ quietEnabled: true, quietStart: '23:00', quietEnd: '08:00' });
  assert.equal(isQuiet('23:00', settings), true); assert.equal(isQuiet('07:59', settings), true);
  assert.equal(isQuiet('08:00', settings), false); assert.equal(isQuiet('22:59', settings), false);
  assert.throws(() => settingsPatch({ ...settings, reminderMode: 'digest', digestTime: '02:00' }), /免打扰/);
  assert.throws(() => settingsPatch({ quietEnabled: true, quietStart: '08:00', quietEnd: '08:00' }), /不能相同/);
});
test('自选周期日历按每周生成，并从恢复日期后开始', () => {
  const slots = calendarSlots({ ...task, repeat: 'custom', weekDays: [1,5], resumeOn: '2026-11-02' }, '2026-10-26T13:01:00Z');
  assert.equal(slots.length, 2); assert.ok(slots.every(slot => slot.repeatInterval === 'week'));
  assert.equal(new Date(slots[0].startTime * 1000).toISOString(), '2026-11-02T13:00:00.000Z');
  assert.equal(new Date(slots[1].startTime * 1000).toISOString(), '2026-11-06T13:00:00.000Z');
});
test('前后端周期与免打扰规则保持同一源码', () => {
  const source = fs.readFileSync(require.resolve('../miniprogram/utils/policy'), 'utf8');
  for (const name of ['xuyixia-api','xuyixia-remind']) assert.equal(fs.readFileSync(require.resolve('../cloudfunctions/'+name+'/policy'), 'utf8'), source);
});
