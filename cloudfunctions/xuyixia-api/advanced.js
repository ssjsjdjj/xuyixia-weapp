'use strict';
const { randomBytes } = require('node:crypto');
const policy = require('./policy');

function createAdvanced({ repo, now, createId, helpers }) {
  const { fail, key, settingsId, recordId, guard, ownTask, publicTask, publicRecord, id, date, time, text, boolean, object } = helpers;
  const scopeFor = (owner, settings) => key('cache', owner, settings.cacheEpoch);
  function normalized(input) {
    object(input, '任务');
    const allowed = ['id', 'type', 'name', 'time', 'note', 'greeting', 'enabled', 'repeat', 'weekDays', 'pinned', 'resumeOn'];
    if (Object.keys(input).some(field => !allowed.includes(field))) fail('INVALID_INPUT', '任务包含不支持的字段');
    if (!['douyin', 'weibo'].includes(input.type)) fail('INVALID_INPUT', '任务类型无效');
    let extras; try { extras = policy.taskOptions(input); } catch (error) { fail('INVALID_INPUT', error.message); }
    return { type: input.type, name: text(input.name, 40, '名称', true), time: time(input.time), note: text(input.note || '', 200, '备注'), greeting: text(input.greeting || '', 200, '文案'), enabled: input.enabled === undefined ? true : boolean(input.enabled, '启用状态'), ...extras };
  }
  const joints = require('./joint').createJointApi({ repo, now, createId, helpers });
  async function handle(action, payload, owner) {
    const stamp = now().toISOString();
    if (joints.actions.includes(action)) return { handled: true, data: await joints.handle(action, payload, owner) };
    if (action === 'getSession') {
      const data = await repo.atomic(async tx => {
        const old = await guard(tx, owner);
        const settings = { ...policy.DEFAULT_SETTINGS, ...(old || {}), owner, cacheEpoch: old && old.cacheEpoch || randomBytes(24).toString('hex'), revision: old && old.revision || 0 };
        if (!old || !old.cacheEpoch) await tx.put('settings', settingsId(owner), settings);
        return { scope: scopeFor(owner, settings) };
      });
      return { handled: true, data };
    }
    if (action === 'getSnapshot') {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await guard(repo, owner);
        if (!before || !before.cacheEpoch) fail('SESSION_CHANGED', '请先验证当前用户身份');
        const [tasks, records] = await Promise.all([repo.query('tasks', { owner }), repo.query('records', { owner })]);
        const after = await guard(repo, owner);
        if (after && before.cacheEpoch === after.cacheEpoch && (before.revision || 0) === (after.revision || 0)) return { handled: true, data: { scope: scopeFor(owner, after), revision: after.revision || 0, state: { version: 1, tasks: tasks.filter(task => !task.deletedAt).map(publicTask), records: records.map(publicRecord), settings: policy.settingsPatch({}, after) } } };
      }
      fail('CONFLICT', '云端数据正在变化，请稍后重试');
    }
    if (action !== 'commitOffline') return { handled: false };
    const mutation = object(payload.mutation, '待同步操作');
    id(mutation.id);
    if (!Number.isInteger(payload.expectedRevision) || payload.expectedRevision < 0) fail('INVALID_INPUT', '同步版本无效');
    const digest = key('mutation-body', mutation);
    const data = await repo.atomic(async tx => {
      const previous = await guard(tx, owner);
      if (!previous || !previous.cacheEpoch || payload.scope !== scopeFor(owner, previous)) fail('SESSION_CHANGED', '云端数据空间已变化，请重新联网加载');
      const mutationKey = key('mutation', owner, previous.cacheEpoch, mutation.id);
      const receipt = await tx.get('mutations', mutationKey);
      if (receipt) {
        if (receipt.digest !== digest) fail('INVALID_INPUT', '重复的操作标识');
        return { result: receipt.result, revision: receipt.revision };
      }
      if ((previous.revision || 0) !== payload.expectedRevision) fail('CONFLICT', '其他设备已修改数据，本机草稿保留，请处理同步冲突');
      let result = null, taskCount = previous.taskCount || 0;
      if (mutation.kind === 'saveTask') {
        const input = object(mutation.task, '任务'), taskId = id(input.id), value = normalized(input);
        const old = await tx.get('tasks', taskId);
        if (old) ownTask(old, owner);
        else if (!mutation.creating) fail('NOT_FOUND', '任务已删除，本机草稿保留');
        if (!old && taskCount >= 100) fail('TASK_LIMIT', '最多可创建100个任务');
        const task = { ...value, id: taskId, owner, createdAt: old ? old.createdAt : stamp, updatedAt: stamp, deletedAt: null };
        await tx.put('tasks', taskId, task); if (!old) taskCount++;
        result = publicTask(task);
      } else if (mutation.kind === 'toggleTask' || mutation.kind === 'deleteTask') {
        const taskId = id(mutation.taskId), task = ownTask(await tx.get('tasks', taskId), owner);
        const deleting = mutation.kind === 'deleteTask';
        const enabled = deleting ? false : boolean(mutation.enabled, '启用状态');
        const changed = { ...task, enabled, ...(enabled ? { resumeOn: '' } : {}), ...(deleting ? { deletedAt: stamp } : {}), updatedAt: stamp };
        await tx.put('tasks', taskId, changed); if (deleting) taskCount = Math.max(0, taskCount - 1);
        result = deleting ? null : publicTask(changed);
      } else if (mutation.kind === 'setCompletion') {
        const taskId = id(mutation.taskId), day = date(mutation.date), completed = boolean(mutation.completed, '完成状态');
        if (day > new Date(now().valueOf() + 8 * 3600000).toISOString().slice(0, 10)) fail('INVALID_INPUT', '不能确认未来日期');
        const task = ownTask(await tx.get('tasks', taskId), owner, !completed);
        const recordKey = recordId(owner, taskId, day), existing = await tx.get('records', recordKey);
        if (completed) { const record = existing || { owner, taskId, date: day, name: task.name, type: task.type, completedAt: stamp }; if (!existing) await tx.put('records', recordKey, record); result = publicRecord(record); }
        else if (existing) await tx.remove('records', recordKey);
      } else if (mutation.kind === 'saveSettings') {
        try { result = policy.settingsPatch(mutation.patch, previous); } catch (error) { fail('INVALID_INPUT', error.message); }
      } else fail('INVALID_INPUT', '不支持的待同步操作');
      const revision = (previous.revision || 0) + 1;
      await tx.put('settings', settingsId(owner), { ...previous, ...(mutation.kind === 'saveSettings' ? result : {}), taskCount, revision, updatedAt: stamp });
      await tx.put('mutations', mutationKey, { owner, digest, result, revision, createdAt: stamp });
      return { result, revision };
    });
    return { handled: true, data };
  }
  return { handle, cleanupJoints: joints.cleanup };
}
module.exports = { createAdvanced };
