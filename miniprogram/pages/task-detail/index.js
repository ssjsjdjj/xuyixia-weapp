const { todayKey, decorateTasks, shiftDate } = require('../../utils/domain');
const { syncMessage, savedToast } = require('../../utils/sync-ui');

Page({
  data: { id: '', task: null, date: '', loading: true, loadError: false, busy: false, calendarBusy: false, subscribeBusy: false, isNew: false, copied: false, temporarilyPaused: false, syncMessage: '', reminderStatus: { wechatConfigured: false, calendarAdded: false, calendarNeedsReview: false, calendarHint: '尚未在本机添加日历提醒' } },
  onLoad(options) { this.setData({ id: options.id || '', isNew: options.created === '1' }); },
  onShow() { this.refresh(); },
  async refresh() {
    const requestId = this._refreshId = (this._refreshId || 0) + 1;
    const date = todayKey();
    this.setData({ loading: true, date, loadError: false });
    try {
      const [task, records] = await Promise.all([getApp().store.getTask(this.data.id), getApp().store.listRecords({ date })]);
      if (requestId !== this._refreshId) return;
      this.setData({ task: task ? decorateTasks([task], records, date)[0] : null, copied: !!task && task.greeting === this._copiedGreeting, temporarilyPaused: !!task && !!task.resumeOn && task.resumeOn > date, syncMessage: syncMessage(getApp().store) });
      this.updateReminderStatus();
    } catch (error) { if (requestId === this._refreshId) { this.setData({ loadError: true }); wx.showToast({ title: '详情未能加载', icon: 'none' }); } }
    finally { if (requestId === this._refreshId) this.setData({ loading: false }); }
  },
  onEdit() { if (this.data.task) wx.navigateTo({ url: `/pages/task-form/index?id=${encodeURIComponent(this.data.id)}` }); },
  updateReminderStatus() {
    const reminders = getApp().reminders;
    if (typeof reminders.getStatus === 'function') this.setData({ reminderStatus: reminders.getStatus(this.data.task) });
  },
  onToday() { wx.switchTab({ url: '/pages/today/index' }); },
  onStartTask() { this.setData({ isNew: false }); },
  onDuplicate() { if (this.data.task) wx.navigateTo({ url: '/pages/task-form/index?copyFrom=' + encodeURIComponent(this.data.id) }); },
  async onPin() {
    if (this.data.busy || !this.data.task) return;
    this.setData({ busy: true });
    try { await getApp().store.saveTask({ ...this.data.task, pinned: !this.data.task.pinned }); await this.refresh(); }
    catch (_) { wx.showToast({ title: '置顶设置未保存，请重试', icon: 'none' }); }
    finally { this.setData({ busy: false }); }
  },
  async onPauseWeek() {
    if (this.data.busy || !this.data.task) return;
    this.setData({ busy: true });
    const resumeOn = shiftDate(todayKey(), 7);
    const confirmed = await new Promise(resolve => wx.showModal({ title: '暂停一周？', content: '从今天起暂停7天，' + resumeOn + '起按原周期恢复。已有手机日历不会自动暂停。', confirmText: '暂停一周', success: result => resolve(result.confirm), fail: () => resolve(false) }));
    try { if (confirmed) { await getApp().store.saveTask({ ...this.data.task, enabled: true, resumeOn }); await this.refresh(); } }
    catch (_) { wx.showToast({ title: '暂停未保存，请重试', icon: 'none' }); }
    finally { this.setData({ busy: false }); }
  },
  onCopy() {
    if (!this.data.task || !this.data.task.greeting) return;
    const greeting = this.data.task.greeting;
    wx.setClipboardData({ data: greeting, success: () => { this._copiedGreeting = greeting; this.setData({ copied: !!this.data.task && this.data.task.greeting === greeting }); wx.showToast({ title: '已复制，尚未发送', icon: 'none' }); }, fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }) });
  },
  async onComplete() {
    if (this.data.busy || !this.data.task) return;
    const completed = this.data.task.completed;
    this.setData({ busy: true });
    try {
      if (todayKey() !== this.data.date) {
        await this.refresh();
        wx.showToast({ title: '日期已更新，请重新确认', icon: 'none' });
        return;
      }
      if (!this.data.task.scheduledToday && !completed) { wx.showToast({ title: '今天未安排该任务', icon: 'none' }); return; }
      await getApp().store.setCompletion(this.data.id, this.data.date, !completed);
      wx.showToast({ title: savedToast(getApp().store, completed ? '已撤销确认' : '今天已确认'), icon: 'none' });
      await this.refresh();
    } catch (error) { wx.showToast({ title: '保存失败，请重试', icon: 'none' }); }
    finally { this.setData({ busy: false }); }
  },
  async onCalendar() {
    if (this.data.calendarBusy || !this.data.task) return;
    this.setData({ calendarBusy: true });
    try {
      const result = await getApp().reminders.addCalendar(this.data.task);
      if (result.status === 'cancelled') return;
      this.updateReminderStatus();
      if (result.status === 'added') wx.showToast({ title: '日历日程已添加', icon: 'success' });
      else wx.showModal({ title: '手机日历提醒', content: result.message, showCancel: false, confirmColor: '#315d49' });
    } catch (error) { wx.showToast({ title: '暂时无法添加日历提醒', icon: 'none' }); }
    finally { this.setData({ calendarBusy: false }); }
  },
  async onSubscribe() {
    if (this.data.subscribeBusy) return;
    this.setData({ subscribeBusy: true });
    try {
      const result = await getApp().reminders.subscribe();
      wx.showModal({ title: '微信提醒授权', content: result.message, showCancel: false, confirmColor: '#315d49' });
    } catch (error) { wx.showToast({ title: '暂时无法申请微信提醒', icon: 'none' }); }
    finally { this.setData({ subscribeBusy: false }); }
  },
  async onToggle() {
    if (this.data.busy || !this.data.task) return;
    const enabled = !this.data.task.enabled || this.data.temporarilyPaused;
    this.setData({ busy: true });
    const confirmed = await new Promise(resolve => wx.showModal({ title: enabled ? '恢复这件小事？' : '暂停这件小事？', content: enabled ? '恢复后会重新显示在每日清单。' : '暂停后暂不显示在每日清单，已有完成记录保留。已添加的日历提醒需到手机日历中单独关闭。', confirmText: enabled ? '恢复' : '暂停', confirmColor: '#315d49', success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (!confirmed) { this.setData({ busy: false }); return; }
    try { await getApp().store.toggleTask(this.data.id, enabled); await this.refresh(); wx.showToast({ title: enabled ? '已恢复' : '已暂停', icon: 'success' }); }
    catch (error) { wx.showToast({ title: '操作失败，请重试', icon: 'none' }); }
    finally { this.setData({ busy: false }); }
  },
  async onDelete() {
    if (this.data.busy || !this.data.task) return;
    this.setData({ busy: true });
    const confirmed = await new Promise(resolve => wx.showModal({ title: '删除这件小事？', content: '删除后无法恢复。手机日历中已添加的提醒需要单独删除。', confirmText: '删除', confirmColor: '#ad4f41', success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (!confirmed) { this.setData({ busy: false }); return; }
    try { await getApp().store.deleteTask(this.data.id); wx.showToast({ title: '已删除', icon: 'success' }); wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/today/index' }) }); }
    catch (error) { wx.showToast({ title: '删除失败，请重试', icon: 'none' }); this.setData({ busy: false }); }
  }
});
