'use strict';
const { randomBytes } = require('node:crypto');
function createJointApi({ repo, now, createId, helpers }) {
  const { fail, key, settingsId, guard, id, text, boolean } = helpers;
  const actions = ['createJoint', 'listJoints', 'getJoint', 'createInvitation', 'previewInvitation', 'joinJoint', 'leaveJoint', 'setJointCompletion'];
  const jointRecordId = (jointId, owner, day) => key('joint-record', jointId, owner, day);
  function member(joint, owner) { if (!joint || !joint.active || (joint.owner !== owner && joint.guest !== owner)) fail('NOT_FOUND', '共同任务不存在或你已退出'); return joint; }
  function tokenValue(value) { if (typeof value !== 'string' || !/^[a-f0-9]{48}$/.test(value)) fail('INVITATION_INVALID', '邀请无效或已过期'); return value; }
  async function view(joint, owner, day) {
    member(joint, owner);
    const other = joint.owner === owner ? joint.guest : joint.owner;
    const [me, them] = await Promise.all([repo.get('jointRecords', jointRecordId(joint.id, owner, day)), other ? repo.get('jointRecords', jointRecordId(joint.id, other, day)) : null]);
    return { id: joint.id, title: joint.title, type: joint.type, isCreator: joint.owner === owner, joined: !!joint.guest, meConfirmed: !!me, otherConfirmed: !!them, date: day, updatedAt: joint.updatedAt };
  }
  async function invalidate(jointId) { for (const invite of await repo.query('invitations', { jointId })) await repo.remove('invitations', invite._id); }
  async function cleanup(owner) {
    const owned = await repo.query('joints', { owner }), joined = await repo.query('joints', { guest: owner });
    for (const candidate of [...owned, ...joined]) {
      await repo.atomic(async tx => {
        const joint = await tx.get('joints', candidate.id); if (!joint) return;
        if (joint.owner === owner) await tx.put('joints', joint.id, { ...joint, active: false, guest: null, updatedAt: now().toISOString() });
        else if (joint.guest === owner) await tx.put('joints', joint.id, { ...joint, guest: null, inviteVersion: (joint.inviteVersion || 0) + 1, updatedAt: now().toISOString() });
      });
      await invalidate(candidate.id);
      for (const record of await repo.query('jointRecords', { jointId: candidate.id })) if (candidate.owner === owner || record.owner === owner) await repo.remove('jointRecords', record._id);
      if (candidate.owner === owner) await repo.remove('joints', candidate.id);
    }
  }
  async function handle(action, payload, owner) {
    const requestTime = now();
    const stamp = requestTime.toISOString(), day = new Date(requestTime.valueOf() + 8 * 3600000).toISOString().slice(0, 10);
    await guard(repo, owner);
    if (action === 'createJoint') {
      const title = text(payload.title, 40, '共同任务名称', true);
      if (!['douyin', 'weibo'].includes(payload.type)) fail('INVALID_INPUT', '请选择平台');
      const jointId = payload.requestId ? key('joint-create', owner, id(payload.requestId)) : createId();
      const existing = await repo.get('joints', jointId);
      if (existing) { member(existing, owner); if (existing.title !== title || existing.type !== payload.type) fail('INVALID_INPUT', '创建标识已用于其他内容'); return view(existing, owner, day); }
      if ((await repo.query('joints', { owner })).filter(j => j.active).length >= 20) fail('TASK_LIMIT', '最多发起20个共同任务');
      const joint = { id: jointId, owner, guest: null, title, type: payload.type, active: true, inviteVersion: 0, createdAt: stamp, updatedAt: stamp };
      const saved = await repo.atomic(async tx => { await guard(tx, owner); const current = await tx.get('joints', joint.id); if (current) { member(current, owner); if (current.title !== title || current.type !== payload.type) fail('INVALID_INPUT', '创建标识已用于其他内容'); return current; } await tx.put('joints', joint.id, joint); return joint; });
      return view(saved, owner, day);
    }
    if (action === 'listJoints') {
      const values = [...await repo.query('joints', { owner }), ...await repo.query('joints', { guest: owner })].filter(j => j.active);
      return Promise.all(values.map(joint => view(joint, owner, day)));
    }
    if (action === 'getJoint') return view(member(await repo.get('joints', id(payload.id)), owner), owner, day);
    if (action === 'createInvitation') {
      const token = randomBytes(24).toString('hex'), expiresAt = new Date(requestTime.valueOf() + 24 * 3600000).toISOString();
      await repo.atomic(async tx => {
        await guard(tx, owner);
        const joint = member(await tx.get('joints', id(payload.id)), owner);
        if (joint.owner !== owner || joint.guest) fail('FORBIDDEN', '只有发起人可在对方加入前生成邀请');
        const version = (joint.inviteVersion || 0) + 1;
        await tx.put('joints', joint.id, { ...joint, inviteVersion: version, updatedAt: stamp });
        await tx.put('invitations', key('invite', token), { owner, jointId: joint.id, version, expiresAt });
      });
      return { token, expiresAt };
    }
    if (action === 'previewInvitation' || action === 'joinJoint') {
      const token = tokenValue(payload.token), inviteKey = key('invite', token);
      const joint = await repo.atomic(async tx => {
        await guard(tx, owner);
        const invite = await tx.get('invitations', inviteKey);
        if (!invite || invite.expiresAt <= stamp) fail('INVITATION_INVALID', '邀请无效或已过期');
        const value = await tx.get('joints', invite.jointId);
        if (!value || !value.active || value.inviteVersion !== invite.version) fail('INVITATION_INVALID', '邀请已失效，请让发起人重新生成');
        await guard(tx, value.owner);
        if (value.guest && value.guest !== owner) fail('INVITATION_FULL', '已有另一位参与者加入');
        if (action === 'joinJoint') {
          if (value.owner === owner) fail('INVALID_INPUT', '发起人不能加入自己的邀请');
          await tx.put('joints', value.id, { ...value, guest: owner, updatedAt: stamp });
          return { ...value, guest: owner, updatedAt: stamp };
        }
        return value;
      });
      return action === 'previewInvitation' ? { title: joint.title, type: joint.type, alreadyMember: joint.owner === owner || joint.guest === owner, id: joint.id } : view(joint, owner, day);
    }
    if (action === 'setJointCompletion') {
      const completed = boolean(payload.completed, '确认状态');
      const joint = await repo.atomic(async tx => {
        await guard(tx, owner);
        const value = member(await tx.get('joints', id(payload.id)), owner);
        await guard(tx, value.owner);
        const recordKey = jointRecordId(value.id, owner, day);
        if (completed) await tx.put('jointRecords', recordKey, { owner, jointId: value.id, date: day, completedAt: stamp });
        else if (await tx.get('jointRecords', recordKey)) await tx.remove('jointRecords', recordKey);
        return value;
      });
      return view(joint, owner, day);
    }
    if (action === 'leaveJoint') {
      const joint = member(await repo.get('joints', id(payload.id)), owner);
      await repo.atomic(async tx => {
        await guard(tx, owner);
        const current = member(await tx.get('joints', joint.id), owner);
        await tx.put('joints', joint.id, { ...current, ...(current.owner === owner ? { active: false, guest: null } : { guest: null }), inviteVersion: (current.inviteVersion || 0) + 1, updatedAt: stamp });
      });
      await invalidate(joint.id);
      for (const record of await repo.query('jointRecords', { jointId: joint.id })) if (joint.owner === owner || record.owner === owner) await repo.remove('jointRecords', record._id);
      return { left: true };
    }
  }
  return { actions, handle, cleanup };
}
module.exports = { createJointApi };
