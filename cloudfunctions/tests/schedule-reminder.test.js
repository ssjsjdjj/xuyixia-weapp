const { test } = require('node:test');
const assert = require('node:assert/strict');
const { memoryRepository } = require('./memory-repository');
const { createReminder,loadConfig,settingsId,subscriptionId } = require('../xuyixia-remind/service');
async function setup(settings) {
  const repo=memoryRepository(), messages=[];
  const config=loadConfig({REMINDER_ENABLED:'true',TEMPLATE_ID:'t',TEMPLATE_FIELDS_JSON:'{"number1":"count","thing2":"summary"}'});
  await repo.put('settings',settingsId('alice'),{owner:'alice',...settings});
  await repo.put('subscriptions',subscriptionId('alice','t'),{owner:'alice',lastResult:'accept',signalCount:5});
  const add = async(id,extra={})=>repo.put('tasks',id,{id,owner:'alice',name:id,type:'douyin',enabled:true,time:'21:00',...extra});
  const run=createReminder({repo,config,now:()=>new Date('2026-10-26T13:00:00Z'),send:async m=>{messages.push(m);return{errCode:0};}});
  return {repo,messages,add,run};
}
test('每日汇总合并不同时点任务，并排除非今日周期与临时暂停',async()=>{
  const h=await setup({reminderMode:'digest',digestTime:'21:00'});
  await h.add('早',{time:'08:00'});await h.add('晚',{time:'23:30'});
  await h.add('非今日',{repeat:'custom',weekDays:[2]});await h.add('暂停',{resumeOn:'2026-10-27'});
  await h.run();assert.equal(h.messages.length,1);assert.equal(h.messages[0].data.number1.value,'2');
});
test('免打扰不发送也不消耗订阅线索，结束后不补发时段内的计划',async()=>{
  const h=await setup({quietEnabled:true,quietStart:'20:00',quietEnd:'08:00'});await h.add('睡觉');await h.run();
  assert.equal(h.messages.length,0);assert.equal((await h.repo.get('subscriptions',subscriptionId('alice','t'))).signalCount,5);
  const later=createReminder({repo:h.repo,config:loadConfig({REMINDER_ENABLED:'true',TEMPLATE_ID:'t',TEMPLATE_FIELDS_JSON:'{"thing1":"title"}'}),now:()=>new Date('2026-10-27T00:00:00Z'),send:async m=>{h.messages.push(m);return{errCode:0};}});
  await later();assert.equal(h.messages.length,0);
});
