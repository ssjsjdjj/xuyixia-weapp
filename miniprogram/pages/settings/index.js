const { platformLabel } = require('../../utils/domain');
const { DEFAULT_SETTINGS, todayKey } = require('../../utils/domain');
const { syncMessage, savedToast } = require('../../utils/sync-ui');

Page({
  data: { time: '21:00', prefs: { ...DEFAULT_SETTINGS }, syncStatus: {}, syncText: '', syncBusy: false, pausedTasks: [], cloud: false, loading: true, loadError: false, busy: false, subscribeBusy: false, clearBusy: false },
  onShow() { this.refresh(); },
  async refresh() {
    const requestId = this._refreshId = (this._refreshId || 0) + 1;
    this.setData({ loading: true, loadError: false, cloud: getApp().config.storageMode === 'cloud' });
    try {
      const [settings, tasks] = await Promise.all([getApp().store.getSettings(), getApp().store.listTasks({ includePaused: true })]);
      if (requestId !== this._refreshId) return;
      this.setData({ time: settings.defaultReminderTime || '21:00', prefs: { ...DEFAULT_SETTINGS, ...settings }, pausedTasks: tasks.filter(task => !task.enabled || (task.resumeOn && task.resumeOn > todayKey())).map(task => ({ ...task, platformLabel: platformLabel(task.type) })), syncStatus: getApp().store.getSyncStatus ? getApp().store.getSyncStatus() : {}, syncText: syncMessage(getApp().store) });
    }
    catch (error) { if (requestId === this._refreshId) { this.setData({ loadError: true }); wx.showToast({ title: '设置未能加载', icon: 'none' }); } }
    finally { if (requestId === this._refreshId) this.setData({ loading: false }); }
  },
  onPausedTask(event) { wx.navigateTo({ url: `/pages/task-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  async onTime(event) {
    if (this.data.busy || this.data.clearBusy) return;
    this.setData({ busy: true });
    try { await getApp().store.saveSettings({ defaultReminderTime: event.detail.value }); this.setData({ time: event.detail.value, prefs: { ...this.data.prefs, defaultReminderTime: event.detail.value } }); wx.showToast({ title: savedToast(getApp().store, '默认时间已更新'), icon: 'none' }); }
    catch (error) { wx.showToast({ title: '保存失败，请重试', icon: 'none' }); }
    finally { this.setData({ busy: false }); }
  },
  async onSubscribe() {
    if (this.data.subscribeBusy) return;
    this.setData({ subscribeBusy: true });
    try { const result = await getApp().reminders.subscribe(); wx.showModal({ title: '微信提醒授权', content: result.message, showCancel: false, confirmColor: '#315d49' }); }
    catch (error) { wx.showToast({ title: '暂时无法申请微信提醒', icon: 'none' }); }
    finally { this.setData({ subscribeBusy: false }); }
  },
  onCalendarHelp() { wx.showModal({ title: '给具体的小事添加日历', content: '打开「今日」中的一件小事，在详情里点击「添加到手机日历」。添加后请到手机日历核对提醒时间；暂停或删除任务后，日历提醒需要单独调整。', confirmText: '知道了', showCancel: false, confirmColor: '#315d49' }); },
  onPrefMode(event) { this.setData({ prefs: { ...this.data.prefs, reminderMode: event.currentTarget.dataset.mode } }); },
  onPrefTime(event) { const field = event.currentTarget.dataset.field; if (['digestTime','quietStart','quietEnd'].includes(field)) this.setData({ prefs: { ...this.data.prefs, [field]: event.detail.value } }); },
  onQuiet(event) { this.setData({ prefs: { ...this.data.prefs, quietEnabled: event.detail.value } }); },
  async onSavePreferences() {
    if (this.data.busy || this.data.clearBusy) return; this.setData({ busy: true });
    try { await getApp().store.saveSettings(this.data.prefs); await this.refresh(); wx.showToast({ title: savedToast(getApp().store, '提醒偏好已保存'), icon: 'none' }); }
    catch (error) { wx.showModal({ title: '提醒偏好未保存', content: error.message || '请检查时间设置后重试', showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  async onSync() {
    if (this.data.syncBusy) return; this.setData({ syncBusy: true });
    try { const status = await getApp().store.syncNow(); await this.refresh(); wx.showToast({ title: status.offline || status.pendingCount || status.conflict ? '仍有未同步内容，请查看提示' : '已同步', icon: 'none' }); }
    catch (_) { wx.showToast({ title: '请联网验证身份后重试', icon: 'none' }); }
    finally { this.setData({ syncBusy: false }); }
  },
  async onDiscardPending() {
    if (this.data.syncBusy || !getApp().store.discardPending) return;
    this.setData({ syncBusy: true });
    const confirmed = await new Promise(resolve => wx.showModal({ title: '放弃本机待同步修改？', content: '将重新读取云端数据。本机尚未上传的新增、编辑和确认会被放弃，无法恢复。断网时不会丢弃草稿。', confirmText: '放弃修改', success: result => resolve(result.confirm), fail: () => resolve(false) }));
    try { if (confirmed) { await getApp().store.discardPending(); await this.refresh(); } }
    catch (_) { wx.showToast({ title: '未取到云端数据，草稿已保留', icon: 'none' }); }
    finally { this.setData({ syncBusy: false }); }
  },
  onManage() { wx.navigateTo({ url: '/pages/tasks/index' }); },
  onShared() { wx.navigateTo({ url: '/pages/shared/index' }); },
  onPrivacy() { wx.navigateTo({ url: '/pages/privacy/index' }); },
  async onClear() {
    if (this.data.clearBusy || this.data.busy) return;
    this.setData({ clearBusy: true });
    const confirmed = await new Promise(resolve => wx.showModal({ title: this.data.cloud ? '清空我的云端数据？' : '清空本机数据？', content: '将删除当前存储中的全部任务、完成记录和偏好设置，无法恢复。已添加到手机日历的提醒不会随之删除。', confirmText: '清空数据', confirmColor: '#ad4f41', success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (!confirmed) { this.setData({ clearBusy: false }); return; }
    try { await getApp().store.clearAll(); await this.refresh(); wx.showToast({ title: '数据已清空', icon: 'success' }); }
    catch (error) { wx.showToast({ title: '清空失败，请重试', icon: 'none' }); }
    finally { this.setData({ clearBusy: false }); }
  }
});
