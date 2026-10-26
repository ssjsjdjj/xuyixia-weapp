const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createLocalStore } = require('../miniprogram/services/store');
const { todayKey, shiftDate, isTaskOnDate } = require('../miniprogram/utils/domain');

function harness() {
  const memory = new Map(), calls = [];
  let confirm = true;
  const wx = {
    getStorageSync: key => memory.has(key) ? structuredClone(memory.get(key)) : '',
    setStorageSync: (key, value) => memory.set(key, structuredClone(value)),
    removeStorageSync: key => memory.delete(key),
    showToast: p => calls.push(['toast', p.title]),
    showModal: p => { calls.push(['modal', p.title]); if (p.success) p.success({ confirm }); },
    navigateTo: p => calls.push(['navigate', p.url]),
    redirectTo: p => calls.push(['redirect', p.url]),
    navigateBack: () => calls.push(['back']),
    switchTab: p => calls.push(['switch', p.url]),
    setNavigationBarTitle: () => {},
    stopPullDownRefresh: () => {},
    setClipboardData: p => { calls.push(['clipboard', p.data]); if (p.success) p.success({}); }
  };
  const app = { config: { storageMode: 'local', cloudEnabled: false }, store: createLocalStore(wx), reminders: { subscribe: async () => ({ status: 'unconfigured', message: '未配置' }), addCalendar: async () => ({ status: 'added', message: '已添加' }) } };
  function page(name) {
    const file = path.resolve(__dirname, '../miniprogram/pages', name, 'index.js');
    let definition;
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      Page: value => { definition = value; }, wx, getApp: () => app,
      getCurrentPages: () => [{}, {}], require: createRequire(file),
      console, Date, setTimeout, clearTimeout
    }, { filename: file });
    definition.data = structuredClone(definition.data);
    definition.setData = patch => Object.assign(definition.data, structuredClone(patch));
    return definition;
  }
  return { app, calls, page, setConfirm: value => { confirm = value; } };
}
const event = id => ({ currentTarget: { dataset: { id } } });

test('页面流程：创建→编辑→今日搜索→确认→记录撤销，重新加载仍保存', async () => {
  const { page, app } = harness();
  const form = page('task-form');
  await form.onLoad({});
  form.setData({ name: '小宇', greeting: '晚上好', time: '20:30' });
  await form.onSave();
  const task = (await app.store.listTasks())[0];
  assert.equal(task.name, '小宇');
  const edit = page('task-form'); await edit.onLoad({ id: task.id });
  edit.setData({ note: '下班后问候' }); await edit.onSave();
  assert.equal((await app.store.getTask(task.id)).note, '下班后问候');
  const today = page('today'); await today.refresh();
  assert.equal(today.data.remaining, 1);
  today.onSearch({ detail: { value: '不存在' } }); assert.equal(today.data.visibleTasks.length, 0);
  today.onSearch({ detail: { value: '小宇' } }); assert.equal(today.data.visibleTasks.length, 1);
  await today.onComplete(event(task.id)); assert.equal(today.data.remaining, 0);
  const records = page('records'); records.onLoad(); await records.refresh();
  assert.equal(records.data.records.length, 1);
  await records.onUndo(event(task.id)); assert.equal(records.data.records.length, 0);
  await today.refresh(); assert.equal(today.data.remaining, 1);
});

test('复制文案不会记为完成；取消删除不丢任务；暂停可恢复', async () => {
  const h = harness();
  const task = await h.app.store.saveTask({ type: 'douyin', name: '好友', time: '21:00', greeting: '你好' });
  const detail = h.page('task-detail'); detail.onLoad({ id: task.id }); await detail.refresh();
  detail.onCopy(); assert.ok(h.calls.some(c => c[0] === 'clipboard' && c[1] === '你好'));
  assert.equal((await h.app.store.listRecords({ date: todayKey() })).length, 0);
  h.setConfirm(false); await detail.onDelete(); assert.ok(await h.app.store.getTask(task.id));
  h.setConfirm(true); await detail.onToggle(); assert.equal((await h.app.store.listTasks()).length, 0);
  await detail.onToggle(); assert.equal((await h.app.store.listTasks()).length, 1);
});

test('表单校验阻止无名任务；存储故障恢复按钮且不显示保存成功', async () => {
  const h = harness(), form = h.page('task-form');
  await form.onLoad({}); await form.onSave(); assert.ok(form.data.errors.name);
  assert.equal((await h.app.store.listTasks()).length, 0);
  form.setData({ name: '小宇' });
  h.app.store.saveTask = async () => { throw new Error('disk full'); };
  await form.onSave(); assert.equal(form.data.busy, false);
  assert.equal(h.calls.filter(c => c[1] === '任务已保存').length, 0);
});

test('未配置真实通知时设置页不宣称发送成功', async () => {
  const h = harness(), settings = h.page('settings');
  await settings.refresh(); await settings.onSubscribe();
  assert.equal(settings.data.subscribeBusy, false);
  assert.ok(h.calls.some(c => c[0] === 'modal' && c[1] === '微信提醒授权'));
});

test('暂停任务在设置中可找到；跨日旧页面不向前一天写完成', async () => {
  const h = harness();
  const task = await h.app.store.saveTask({ type: 'douyin', name: '好友', time: '21:00' });
  await h.app.store.toggleTask(task.id, false);
  const settings = h.page('settings'); await settings.refresh();
  assert.equal(settings.data.pausedTasks[0].id, task.id);
  settings.onPausedTask(event(task.id));
  assert.ok(h.calls.some(c => c[0] === 'navigate' && c[1].includes(task.id)));
  await h.app.store.toggleTask(task.id, true);
  const today = h.page('today'); await today.refresh();
  today.setData({ date: shiftDate(todayKey(), -1) });
  await today.onComplete(event(task.id));
  assert.equal((await h.app.store.listRecords({})).length, 0);
  assert.equal(today.data.date, todayKey());
});

test('记录日期快速切换时旧请求不能覆盖新日期的结果', async () => {
  const h = harness(), records = h.page('records');
  records.onLoad();
  const previous = shiftDate(todayKey(), -1), pending = [];
  h.app.store.listRecords = ({ date }) => new Promise(resolve => pending.push({ date, resolve }));
  records.setData({ date: previous }); const first = records.refresh();
  records.setData({ date: todayKey() }); const second = records.refresh();
  pending[1].resolve([{ taskId: 'new', date: todayKey(), name: '今天', type: 'weibo', completedAt: new Date().toISOString() }]);
  await second;
  pending[0].resolve([{ taskId: 'old', date: previous, name: '昨天', type: 'weibo', completedAt: new Date().toISOString() }]);
  await first;
  assert.equal(records.data.records[0].taskId, 'new');
  assert.equal(records.timeLabel('2026-10-26T13:30:00.000Z'), '21:30 确认');
});

test('首次保存进入对应任务的提醒设置流程，编辑仍返回原页面', async () => {
  const h = harness(), form = h.page('task-form');
  await form.onLoad({}); form.setData({ name: '第一次添加' }); await form.onSave();
  const task = (await h.app.store.listTasks())[0];
  assert.ok(h.calls.some(c => c[0] === 'redirect' && c[1] === `/pages/task-detail/index?id=${task.id}&created=1`));
  const detail = h.page('task-detail'); detail.onLoad({ id: task.id, created: '1' }); await detail.refresh();
  assert.equal(detail.data.isNew, true);
  const edit = h.page('task-form'); await edit.onLoad({ id: task.id }); edit.setData({ name: '修改后的名字' }); await edit.onSave();
  assert.ok(h.calls.some(c => c[0] === 'back'));
});

test('已有同名暂停任务时取消重复创建，保留输入并恢复按钮', async () => {
  const h = harness();
  const existing = await h.app.store.saveTask({ type: 'douyin', name: '小宇', time: '21:00' });
  await h.app.store.toggleTask(existing.id, false);
  const form = h.page('task-form'); await form.onLoad({}); form.setData({ name: ' 小宇 ', note: '保留草稿' });
  h.setConfirm(false); await form.onSave();
  assert.equal((await h.app.store.listTasks({ includePaused: true })).length, 1);
  assert.equal(form.data.note, '保留草稿'); assert.equal(form.data.busy, false);
  assert.equal(h.calls.filter(c => c[0] === 'redirect').length, 0);
});

test('确认连点不会重复写记录，并能就地撤销刚才的操作', async () => {
  const h = harness(), today = h.page('today');
  const task = await h.app.store.saveTask({ type: 'weibo', name: '打卡', time: '21:00' });
  await today.refresh();
  await Promise.all([today.onComplete(event(task.id)), today.onComplete(event(task.id))]);
  assert.equal((await h.app.store.listRecords({})).length, 1);
  assert.equal(today.data.lastAction.id, task.id);
  await today.onUndoLast();
  assert.equal((await h.app.store.listRecords({})).length, 0);
  assert.equal(today.data.lastAction, null); assert.equal(today.data.remaining, 1);
});

test('取消日历操作后不会再弹第二个结果框，复制提示不记为发送', async () => {
  const h = harness(), detail = h.page('task-detail');
  const task = await h.app.store.saveTask({ type: 'douyin', name: '小宇', time: '21:00', greeting: '你好' });
  detail.onLoad({ id: task.id }); await detail.refresh();
  h.app.reminders.addCalendar = async () => ({ status: 'cancelled', message: '已取消' });
  const dialogs = h.calls.filter(c => c[0] === 'modal').length;
  await detail.onCalendar();
  assert.equal(h.calls.filter(c => c[0] === 'modal').length, dialogs);
  detail.onCopy(); assert.equal(detail.data.copied, true);
  assert.equal((await h.app.store.listRecords({})).length, 0);
});

test('修改文案后清除旧复制提示；首次保存引导可跳过进入处理步骤', async () => {
  const h = harness(), detail = h.page('task-detail');
  const task = await h.app.store.saveTask({ type: 'douyin', name: '小宇', time: '21:00', greeting: '原文案' });
  detail.onLoad({ id: task.id, created: '1' }); await detail.refresh();
  assert.equal(detail.data.isNew, true); detail.onStartTask(); assert.equal(detail.data.isNew, false);
  detail.onCopy(); assert.equal(detail.data.copied, true);
  await h.app.store.saveTask({ ...task, greeting: '修改后的文案' }); await detail.refresh();
  assert.equal(detail.data.copied, false);
});

test('复制任务仅沿用周期和内容，新对象为空，置顶与暂停不复制', async () => {
  const h = harness();
  const task = await h.app.store.saveTask({ type: 'douyin', name: '原好友', time: '22:00', repeat: 'custom', weekDays: [1,3], pinned: true, resumeOn: shiftDate(todayKey(),7), greeting: '你好' });
  const copy = h.page('task-form'); await copy.onLoad({ copyFrom: task.id });
  assert.equal(copy.data.name, ''); assert.equal(copy.data.id, ''); assert.equal(copy.data.pinned, false); assert.equal(copy.data.resumeOn, '');
  assert.equal(copy.data.repeat, 'custom'); assert.deepEqual([...copy.data.weekDays], [1,3]);
  copy.setData({ name: '新好友' }); await copy.onSave();
  const tasks = await h.app.store.listTasks({includePaused:true}); assert.equal(tasks.length,2); assert.equal(tasks.find(t=>t.id===task.id).name,'原好友');
});

test('暂停一周从今日移出，到期按原周期自动恢复，立即恢复会取消期限', async () => {
  const h = harness(), detail = h.page('task-detail');
  const task = await h.app.store.saveTask({type:'douyin',name:'休假',time:'21:00'});
  detail.onLoad({id:task.id}); await detail.refresh(); await detail.onPauseWeek();
  const paused=await h.app.store.getTask(task.id); assert.equal(paused.enabled,true); assert.equal(paused.resumeOn,shiftDate(todayKey(),7));
  assert.equal(isTaskOnDate(paused,todayKey()),false); assert.equal(isTaskOnDate(paused,paused.resumeOn),true);
  await detail.onToggle(); assert.equal((await h.app.store.getTask(task.id)).resumeOn,'');
});

test('非今日周期不在首页但可在全部任务找到，共同任务本机模式不伪造双方状态', async () => {
  const h=harness();const weekday=new Date(todayKey()+'T00:00:00Z').getUTCDay()||7;
  await h.app.store.saveTask({type:'douyin',name:'另一天',time:'21:00',repeat:'custom',weekDays:[weekday===7?1:weekday+1]});
  const today=h.page('today');await today.refresh();assert.equal(today.data.total,0);assert.equal(today.data.pausedCount,1);
  const manage=h.page('tasks');await manage.refresh();assert.equal(manage.data.tasks.length,1);
  const shared=h.page('shared');shared.onLoad({});await shared.refresh();assert.equal(shared.data.cloud,false);assert.equal(shared.data.joints.length,0);
});
