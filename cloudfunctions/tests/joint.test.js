const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi } = require('../xuyixia-api/service');
const { memoryRepository } = require('./memory-repository');
function setup() {
  const repo = memoryRepository(); let date = new Date('2026-10-26T13:00:00Z');
  const service = createApi({ repo, now: () => date });
  const call = async (owner, action, payload = {}) => service({ action, payload }, { OPENID: owner });
  return { repo, call, advance: value => { date = new Date(value); }, create: async () => (await call('alice','createJoint',{title:'每日问候',type:'douyin'})).data };
}
test('共同任务只有自愿加入的双方可看状态，确认互相独立且按日重置', async () => {
  const h = setup(), joint = await h.create();
  const invite = (await h.call('alice','createInvitation',{id:joint.id})).data;
  const preview = (await h.call('bob','previewInvitation',{token:invite.token})).data;
  assert.equal(preview.title,'每日问候'); assert.equal(preview.meConfirmed,undefined); assert.equal(preview.otherConfirmed,undefined);
  assert.equal((await h.call('mallory','getJoint',{id:joint.id})).ok,false);
  await h.call('bob','joinJoint',{token:invite.token});
  await h.call('alice','setJointCompletion',{id:joint.id,completed:true});
  const bob = (await h.call('bob','getJoint',{id:joint.id})).data;
  assert.equal(bob.meConfirmed,false); assert.equal(bob.otherConfirmed,true); assert.equal(bob.owner,undefined);
  await h.call('bob','setJointCompletion',{id:joint.id,completed:true});
  assert.equal((await h.call('alice','getJoint',{id:joint.id})).data.otherConfirmed,true);
  h.advance('2026-10-26T16:00:00Z'); const next = (await h.call('alice','getJoint',{id:joint.id})).data;
  assert.equal(next.meConfirmed,false); assert.equal(next.otherConfirmed,false);
});
test('邀请轮换、过期与两人上限，不能抢占已加入者', async () => {
  const h = setup(), joint = await h.create();
  const old = (await h.call('alice','createInvitation',{id:joint.id})).data;
  const invite = (await h.call('alice','createInvitation',{id:joint.id})).data;
  assert.equal((await h.call('bob','previewInvitation',{token:old.token})).error.code,'INVITATION_INVALID');
  const results = await Promise.all(['bob','mallory'].map(owner => h.call(owner,'joinJoint',{token:invite.token})));
  assert.equal(results.filter(result=>result.ok).length,1); assert.equal(results.filter(result=>!result.ok)[0].error.code,'INVITATION_FULL');
  const other = await h.create(), expiry = (await h.call('alice','createInvitation',{id:other.id})).data;
  h.advance('2026-10-27T13:00:01Z'); assert.equal((await h.call('bob','joinJoint',{token:expiry.token})).error.code,'INVITATION_INVALID');
});
test('退出移除共享资格；清空发起人数据清除共同内容但不删对方私人任务', async () => {
  const h = setup(), joint = await h.create(), invite=(await h.call('alice','createInvitation',{id:joint.id})).data;
  await h.call('bob','joinJoint',{token:invite.token}); await h.call('bob','setJointCompletion',{id:joint.id,completed:true});
  await h.call('bob','leaveJoint',{id:joint.id});
  assert.equal((await h.call('bob','getJoint',{id:joint.id})).ok,false);
  assert.equal((await h.call('alice','getJoint',{id:joint.id})).data.joined,false);
  await h.call('bob','saveTask',{task:{name:'bob私人',type:'weibo',time:'21:00'}});
  await h.call('alice','clearAll');
  assert.equal((await h.repo.query('joints')).length,0);
  assert.equal((await h.repo.query('jointRecords')).length,0);
  assert.equal((await h.call('bob','listTasks')).data.length,1);
});

test('共同任务创建重试使用同一请求标识，不重复创建',async()=>{
  const h=setup(),payload={title:'一次创建',type:'douyin',requestId:'same-request'};
  const responses=await Promise.all([h.call('alice','createJoint',payload),h.call('alice','createJoint',payload)]);
  assert.equal(responses[0].data.id,responses[1].data.id);assert.equal((await h.repo.query('joints')).length,1);
  const collisions=await Promise.all(['内容一','内容二'].map(title=>h.call('alice','createJoint',{...payload,title,requestId:'different-content'})));
  assert.equal(collisions.filter(result=>result.ok).length,1);
  assert.equal(collisions.find(result=>!result.ok).error.code,'INVALID_INPUT');
});

test('零点期间的共同确认与返回状态使用同一北京时间日期',async()=>{
  const h=setup(),joint=await h.create(),atomic=h.repo.atomic.bind(h.repo);
  h.advance('2026-10-26T15:59:59.999Z');
  h.repo.atomic=async callback=>{h.advance('2026-10-26T16:00:00.001Z');return atomic(callback);};
  const result=await h.call('alice','setJointCompletion',{id:joint.id,completed:true});
  assert.equal(result.ok,true);assert.equal(result.data.date,'2026-10-26');assert.equal(result.data.meConfirmed,true);
  const records=await h.repo.query('jointRecords');assert.equal(records.length,1);assert.equal(records[0].date,'2026-10-26');
  const next=(await h.call('alice','getJoint',{id:joint.id})).data;
  assert.equal(next.date,'2026-10-27');assert.equal(next.meConfirmed,false);
});
