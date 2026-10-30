'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { timing, todayView } = require('../miniprogram/utils/today-view');

test('处理时间按北京时间计算，在30分钟和到点边界更新，不猜测平台状态',()=>{
  const task={time:'21:00',completed:false},day='2026-10-30';
  assert.equal(timing(task,day,Date.parse('2026-10-30T12:29:59Z')).timingKind,'later');
  assert.equal(timing(task,day,Date.parse('2026-10-30T12:30:00Z')).timingKind,'soon');
  assert.equal(timing(task,day,Date.parse('2026-10-30T12:59:59Z')).timingLabel,'还有1分钟到处理时间');
  assert.equal(timing(task,day,Date.parse('2026-10-30T13:00:00Z')).timingKind,'due');
  assert.equal(timing({...task,completed:true},day,Date.parse('2026-10-30T13:00:00Z')).timingLabel,'');
  assert.equal(timing(task,day,Date.parse('2026-10-30T16:00:00Z')).timingLabel,'');
});

test('状态计数对应当前平台和关键词，筛选不修改原始任务或排序',()=>{
  const tasks=[{id:'pinned',name:'ALICE',note:'晚饭后',type:'douyin',time:'22:00',pinned:true,completed:false},{id:'done',name:'Alice 已完成',type:'douyin',time:'20:00',completed:true},{id:'other',name:'Alice 微博',type:'weibo',time:'19:00',completed:false}];
  const before=structuredClone(tasks),options={date:'2026-10-30',now:Date.parse('2026-10-30T12:00:00Z'),query:' alice ',filter:'douyin',statusFilter:'all'};
  const all=todayView(tasks,options);assert.deepEqual(all.statusCounts,{all:2,pending:1,confirmed:1});assert.deepEqual(all.visibleTasks.map(task=>task.id),['pinned','done']);
  assert.deepEqual(todayView(tasks,{...options,statusFilter:'confirmed'}).visibleTasks.map(task=>task.id),['done']);
  assert.deepEqual(todayView(tasks,{...options,query:'晚饭后',statusFilter:'pending'}).visibleTasks.map(task=>task.id),['pinned']);assert.deepEqual(tasks,before);
});

test('完成后的空列表提供返回已确认入口，已确认空列表提供待确认入口',()=>{
  const task={id:'one',name:'好友',type:'douyin',time:'21:00',completed:true},options={date:'2026-10-30',now:Date.parse('2026-10-30T12:00:00Z')};
  assert.equal(todayView([task],options).emptyAction,'confirmed');
  assert.equal(todayView([{...task,completed:false}],{...options,statusFilter:'confirmed'}).emptyAction,'pending');
  const noMatch=todayView([task],{...options,query:'没有这个名字'});assert.equal(noMatch.emptyAction,'reset');assert.equal(noMatch.statusCounts.all,0);
});
