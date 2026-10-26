const { todayKey, decorateTasks, formatDateLabel, isTaskOnDate } = require('../../utils/domain');
const { syncMessage, savedToast } = require('../../utils/sync-ui');

Page({
  data: { date: '', dateLabel: '', tasks: [], visibleTasks: [], query: '', filter: 'all', total: 0, completed: 0, remaining: 0, pausedCount: 0, progress: 0, loading: true, loadError: false, busyId: '', lastAction: null, reminderHint: '微信消息提醒暂未启用', syncMessage: '' },
  onShow() { this.setData({ lastAction: null }); this.refresh(); },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  async refresh() {
    const requestId = this._refreshId = (this._refreshId || 0) + 1;
    const date = todayKey();
    const config = getApp().config;
    this.setData({ loading: true, loadError: false, date, dateLabel: formatDateLabel(date), reminderHint: config.cloudEnabled && config.subscriptionTemplateId ? '微信消息需主动订阅' : '微信消息提醒暂未启用' });
    try {
      const [tasks, records] = await Promise.all([getApp().store.listTasks({ includePaused: true }), getApp().store.listRecords({ date })]);
      if (requestId !== this._refreshId) return;
      const decorated = decorateTasks(tasks.filter(task => isTaskOnDate(task, date)), records, date);
      const completed = decorated.filter(task => task.completed).length;
      this.setData({ tasks: decorated, total: decorated.length, completed, remaining: decorated.length - completed, pausedCount: tasks.filter(task => !isTaskOnDate(task, date)).length, progress: decorated.length ? Math.round(completed / decorated.length * 100) : 0, syncMessage: syncMessage(getApp().store) });
      this.applyFilter();
    } catch (error) {
      if (requestId !== this._refreshId) return;
      this.setData({ loadError: true });
      wx.showToast({ title: '清单暂时未能加载', icon: 'none' });
    } finally { if (requestId === this._refreshId) this.setData({ loading: false }); }
  },
  applyFilter() {
    const query = this.data.query.trim().toLowerCase();
    this.setData({ visibleTasks: this.data.tasks.filter(task => (this.data.filter === 'all' || task.type === this.data.filter) && (!query || `${task.name} ${task.note || ''}`.toLowerCase().includes(query))) });
  },
  onSearch(event) { this.setData({ query: event.detail.value }); this.applyFilter(); },
  onFilter(event) { this.setData({ filter: event.currentTarget.dataset.type }); this.applyFilter(); },
  onResetFilters() { this.setData({ query: '', filter: 'all' }); this.applyFilter(); },
  onCreate() { wx.navigateTo({ url: '/pages/task-form/index' }); },
  onReminderSettings() { wx.switchTab({ url: '/pages/settings/index' }); },
  onManage() { wx.navigateTo({ url: '/pages/tasks/index' }); },
  onShared() { wx.navigateTo({ url: '/pages/shared/index' }); },
  onDetail(event) { wx.navigateTo({ url: `/pages/task-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  async onComplete(event) {
    if (this.data.busyId) return;
    const id = event.currentTarget.dataset.id;
    const task = this.data.tasks.find(item => item.id === id);
    if (!task) return;
    this.setData({ busyId: id });
    try {
      if (todayKey() !== this.data.date) {
        await this.refresh();
        wx.showToast({ title: '日期已更新，请重新确认', icon: 'none' });
        return;
      }
      await getApp().store.setCompletion(id, this.data.date, !task.completed);
      this.setData({ lastAction: { id, name: task.name, completed: !task.completed, date: this.data.date } });
      wx.showToast({ title: savedToast(getApp().store, task.completed ? '已撤销确认' : '今天已确认'), icon: 'none' });
      await this.refresh();
    } catch (error) { wx.showToast({ title: '保存失败，请重试', icon: 'none' }); }
    finally { this.setData({ busyId: '' }); }
  },
  async onUndoLast() {
    if (this.data.busyId || !this.data.lastAction) return;
    const action = this.data.lastAction;
    this.setData({ busyId: action.id });
    try {
      if (action.date !== todayKey()) { this.setData({ lastAction: null }); await this.refresh(); return; }
      await getApp().store.setCompletion(action.id, action.date, !action.completed);
      this.setData({ lastAction: null });
      await this.refresh();
      wx.showToast({ title: '已撤销刚才的操作', icon: 'success' });
    } catch (_) { wx.showToast({ title: '撤销失败，请重试', icon: 'none' }); }
    finally { this.setData({ busyId: '' }); }
  }
});
