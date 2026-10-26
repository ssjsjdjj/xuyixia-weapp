Page({
  data: { cloud: false, loading: false, busy: false, loadError: false, title: '', type: 'douyin', joints: [], invitation: null, inviteToken: '', inviteJointId: '', inviteTitle: '', expiresAt: '' },
  onLoad(options) { this._incoming = options.invite || ''; this.setData({ cloud: !!getApp().config.cloudEnabled }); },
  onShow() { this.refresh(); },
  async refresh() {
    if (!this.data.cloud) return;
    const requestId = this._refreshId = (this._refreshId || 0) + 1;
    this.setData({ loading: true, loadError: false });
    try {
      const joints = await getApp().store.shared('listJoints', {});
      let invitation = null;
      if (this._incoming) invitation = await getApp().store.shared('previewInvitation', { token: this._incoming });
      if (requestId === this._refreshId) this.setData({ joints, invitation });
    } catch (error) { if (requestId === this._refreshId) { this.setData({ loadError: true }); wx.showModal({ title: '共同任务暂时不可用', content: error.message || '请联网后重试', showCancel: false }); } }
    finally { if (requestId === this._refreshId) this.setData({ loading: false }); }
  },
  onTitle(event) { this._createRequestId = ''; this.setData({ title: event.detail.value }); },
  onType(event) { this._createRequestId = ''; this.setData({ type: event.currentTarget.dataset.type }); },
  async perform(action, payload, after) {
    if (this.data.busy) return; this.setData({ busy: true });
    try { const result = await getApp().store.shared(action, payload); if (after) after(result); await this.refresh(); }
    catch (error) { wx.showModal({ title: '操作未完成', content: error.message || '请联网后重试', showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  onCreate() {
    const title = this.data.title.trim();
    if (!title || Array.from(title).length > 40) { wx.showToast({ title: '请输入1—40字的任务名称', icon: 'none' }); return; }
    if (!this._createRequestId) this._createRequestId = 'joint_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,12);
    return this.perform('createJoint', { title, type: this.data.type, requestId: this._createRequestId }, () => { this._createRequestId = ''; this.setData({ title: '' }); });
  },
  onJoin() { return this.perform('joinJoint', { token: this._incoming }, () => { this._incoming = ''; this.setData({ invitation: null }); }); },
  onComplete(event) { const id = event.currentTarget.dataset.id, task = this.data.joints.find(item => item.id === id); if (task) return this.perform('setJointCompletion', { id, completed: !task.meConfirmed }); },
  async onInvite(event) {
    const id = event.currentTarget.dataset.id, task = this.data.joints.find(item => item.id === id);
    return this.perform('createInvitation', { id }, result => this.setData({ inviteToken: result.token, inviteJointId: id, inviteTitle: task.title, expiresAt: result.expiresAt }));
  },
  onShareAppMessage() { return this.data.inviteToken ? { title: '邀请你加入：' + this.data.inviteTitle, path: '/pages/shared/index?invite=' + this.data.inviteToken } : { title: '续一下 · 双方共同任务', path: '/pages/shared/index' }; },
  async onLeave(event) {
    if (this.data.busy) return;
    const confirmed = await new Promise(resolve => wx.showModal({ title: '退出或关闭共同任务？', content: '参与者退出后不再共享状态；发起人退出会关闭此任务。不会修改双方的私人任务或手机日历。', success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (confirmed) return this.perform('leaveJoint', { id: event.currentTarget.dataset.id }, () => this.setData({ inviteToken: '', inviteJointId: '' }));
  },
  onPersonalReminder(event) { const task = this.data.joints.find(item => item.id === event.currentTarget.dataset.id); if (task) wx.navigateTo({ url: '/pages/task-form/index?title=' + encodeURIComponent(task.title) + '&type=' + task.type }); }
});
