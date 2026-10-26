const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReminders } = require('../miniprogram/services/reminders');

test('未配置时不弹订阅框，也不产生虚假的发送状态', async () => {
  let called = false;
  const api = { requestSubscribeMessage: () => { called = true; } };
  const reminders = createReminders(api, { cloudEnabled: false }, {});
  assert.equal((await reminders.subscribe()).status, 'unconfigured');
  assert.equal(called, false);
});

test('拒绝订阅不注册；接受授权仅注册提示线索', async () => {
  let choice = 'reject'; let count = 0;
  const api = { requestSubscribeMessage: p => p.success({ template: choice }) };
  const service = createReminders(api, { cloudEnabled: true, subscriptionTemplateId: 'template' }, { registerSubscription: async () => { count++; } });
  assert.equal((await service.subscribe()).status, 'rejected');
  assert.equal(count, 0);
  choice = 'accept';
  assert.equal((await service.subscribe()).status, 'accepted');
  assert.equal(count, 1);
});

test('取消添加日历时不写入系统，成功后记录本机防重复线索', async () => {
  let confirm = false; let written = 0; let record;
  const api = {
    getStorageSync: () => record || '',
    setStorageSync: (_, value) => { record = value; },
    showModal: p => p.success({ confirm }),
    authorize: p => p.success({}),
    addPhoneRepeatCalendar: p => { assert.equal(p.repeatInterval, 'day'); assert.ok(p.startTime > Date.now() / 1000); written++; p.success({}); }
  };
  const service = createReminders(api, {}, {}), task = { id: 'a', type: 'douyin', name: '小宇', time: '21:00', enabled: true };
  assert.equal((await service.addCalendar(task)).status, 'cancelled');
  assert.equal(written, 0);
  confirm = true;
  assert.equal((await service.addCalendar(task)).status, 'added');
  assert.equal(written, 1);
  assert.equal(record.a.time, '21:00');
});

test('带语音的订阅接受结果归一化为后端支持的授权线索', async () => {
  let registered;
  const api = { requestSubscribeMessage: p => p.success({ template: 'acceptWithAudio' }) };
  const service = createReminders(api, { cloudEnabled: true, subscriptionTemplateId: 'template' }, {
    registerSubscription: async (_, choice) => { registered = choice; }
  });
  assert.equal((await service.subscribe()).status, 'accepted');
  assert.equal(registered, 'accept');
});

test('日历已添加后即使本机防重复线索写入失败，也不误导用户再试', async () => {
  const api = {
    getStorageSync: () => '', setStorageSync: () => { throw new Error('quota'); },
    showModal: p => p.success({ confirm: true }), authorize: p => p.success({}),
    addPhoneRepeatCalendar: p => p.success({})
  };
  const result = await createReminders(api, {}, {}).addCalendar({ id: 'a', type: 'weibo', name: '打卡', time: '22:00', enabled: true });
  assert.equal(result.status, 'added');
});

test('修改日历任务后提示独立核对，不把本机添加记录当作当前系统状态', async () => {
  const api = { getStorageSync: () => ({ a: { time: '21:00', name: '小宇', type: 'douyin' } }) };
  const service = createReminders(api, { cloudEnabled: false }, {});
  const task = { id: 'a', name: '小宇', type: 'douyin', time: '22:00', enabled: true };
  assert.equal(service.getStatus(task).calendarNeedsReview, true);
  assert.match(service.getStatus(task).calendarHint, /任务已修改/);
  task.time = '21:00'; assert.match(service.getStatus(task).calendarHint, /本机曾添加/);
  task.enabled = false; assert.match(service.getStatus(task).calendarHint, /仍需手动关闭/);
  assert.equal(service.getStatus(task).wechatConfigured, false);
});

test('每周多个日程中途取消后只补齐缺失项，避免重建已添加的星期', async () => {
  let ledger='',attempts=0,failSecond=true;
  const api={getStorageSync:()=>ledger,setStorageSync:(_,value)=>{ledger=structuredClone(value);},showModal:p=>p.success({confirm:true}),authorize:p=>p.success({}),addPhoneRepeatCalendar:p=>{attempts++;assert.equal(p.repeatInterval,'week');if(failSecond&&attempts===2)p.fail({errMsg:'cancel'});else p.success({});}};
  const service=createReminders(api,{},{}),task={id:'weekly',type:'douyin',name:'自选',time:'21:00',enabled:true,repeat:'custom',weekDays:[1,5]};
  assert.equal((await service.addCalendar(task)).status,'partial');assert.equal(ledger.weekly.completed,false);
  failSecond=false;assert.equal((await service.addCalendar(task)).status,'added');assert.equal(attempts,3);assert.equal(ledger.weekly.completed,true);
});
