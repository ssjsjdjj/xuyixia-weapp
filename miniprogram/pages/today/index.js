const { todayKey, decorateTasks, formatDateLabel, isTaskOnDate } = require('../../utils/domain');
const { syncMessage, savedToast } = require('../../utils/sync-ui');
const { todayView } = require('../../utils/today-view');

Page({
  data: { date: '', dateLabel: '', tasks: [], visibleTasks: [], query: '', filter: 'all', statusFilter: 'pending', statusCounts: { all: 0, pending: 0, confirmed: 0 }, total: 0, completed: 0, remaining: 0, pausedCount: 0, progress: 0, hasLoaded: false, loading: true, refreshing: false, stale: false, loadError: false, busyId: '', lastAction: null, reminderHint: '微信消息提醒暂未启用', syncMessage: '' },
  onShow() { this._visible = true; this.setData({ lastAction: null }); this.startClock(); return this.refresh(); },
  onHide() { this.stopClock(); },
  onUnload() { this.stopClock(); this._refreshId = (this._refreshId || 0) + 1; },
  stopClock() { this._visible = false; clearTimeout(this._clock); this._clock = null; },
  startClock() {
    clearTimeout(this._clock);
    this._clock = setTimeout(() => {
      if (!this._visible) return;
      if (todayKey() !== this.data.date) { this.setData({ lastAction: null }); this.refresh(); }
      else { this.applyFilter(); const message = syncMessage(getApp().store); if (message !== this.data.syncMessage) this.setData({ syncMessage: message }); }
      this.startClock();
    }, 30000);
  },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  async refresh() {
    const requestId = this._refreshId = (this._refreshId || 0) + 1;
    const date = todayKey();
    const config = getApp().config;
    const keepList = this.data.hasLoaded && this.data.date === date;
    this.setData({ loading: !keepList, refreshing: keepList, loadError: false, stale: false, reminderHint: config.cloudEnabled && config.subscriptionTemplateId ? '微信消息需主动订阅' : '微信消息提醒暂未启用', syncMessage: syncMessage(getApp().store) });
    if (!keepList) this.setData({ date, dateLabel: formatDateLabel(date), tasks: [], visibleTasks: [], total: 0, completed: 0, remaining: 0, pausedCount: 0, progress: 0, lastAction: null, hasLoaded: false, statusCounts: { all: 0, pending: 0, confirmed: 0 } });
    try {
      const [tasks, records] = await Promise.all([getApp().store.listTasks({ includePaused: true }), getApp().store.listRecords({ date })]);
      if (requestId !== this._refreshId) return;
      if (todayKey() !== date) return this.refresh();
      const decorated = decorateTasks(tasks.filter(task => isTaskOnDate(task, date)), records, date);
      const completed = decorated.filter(task => task.completed).length;
      this.setData({ tasks: decorated, hasLoaded: true, total: decorated.length, completed, remaining: decorated.length - completed, pausedCount: tasks.filter(task => !isTaskOnDate(task, date)).length, progress: decorated.length ? Math.round(completed / decorated.length * 100) : 0, syncMessage: syncMessage(getApp().store) });
      this.applyFilter();
    } catch (error) {
      if (requestId !== this._refreshId) return;
      this.setData({ loadError: !keepList, stale: keepList, syncMessage: syncMessage(getApp().store) });
      wx.showToast({ title: '清单暂时未能加载', icon: 'none' });
    } finally { if (requestId === this._refreshId) this.setData({ loading: false, refreshing: false }); }
  },
  applyFilter() {
    const view = todayView(this.data.tasks, { date: this.data.date, query: this.data.query, filter: this.data.filter, statusFilter: this.data.statusFilter, now: Date.now() });
    const patch = {};
    for (const [key, value] of Object.entries(view)) if (JSON.stringify(this.data[key]) !== JSON.stringify(value)) patch[key] = value;
    if (Object.keys(patch).length) this.setData(patch);
  },
  onSearch(event) { this.setData({ query: event.detail.value }); this.applyFilter(); },
  onFilter(event) { const filter = event.currentTarget.dataset.type; if (!['all', 'douyin', 'weibo'].includes(filter)) return; this.setData({ filter }); this.applyFilter(); },
  onStatusFilter(event) { const statusFilter = event.currentTarget.dataset.status; if (!['all', 'pending', 'confirmed'].includes(statusFilter)) return; this.setData({ statusFilter }); this.applyFilter(); },
  onClearSearch() { this.setData({ query: '' }); this.applyFilter(); },
  onResetFilters() { this.setData({ query: '', filter: 'all', statusFilter: 'pending' }); this.applyFilter(); },
  onEmptyAction() { if (this.data.emptyAction === 'reset') this.onResetFilters(); else this.onStatusFilter({ currentTarget: { dataset: { status: this.data.emptyAction } } }); },
  onCreate() { wx.navigateTo({ url: '/pages/task-form/index' }); },
  onReminderSettings() { wx.switchTab({ url: '/pages/settings/index' }); },
  onManage() { wx.navigateTo({ url: '/pages/tasks/index' }); },
  onShared() { wx.navigateTo({ url: '/pages/shared/index' }); },
  onDetail(event) { wx.navigateTo({ url: `/pages/task-detail/index?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }); },
  async onComplete(event) {
    if (this.data.busyId || this.data.loading || this.data.refreshing || this.data.stale || this.data.loadError) return;
    const id = event.currentTarget.dataset.id;
    const task = this.data.tasks.find(item => item.id === id);
    if (!task) return;
    const date = this.data.date;
    this.setData({ busyId: id });
    try {
      if (todayKey() !== date) {
        await this.refresh();
        wx.showToast({ title: '日期已更新，请重新确认', icon: 'none' });
        return;
      }
      await getApp().store.setCompletion(id, date, !task.completed);
      this.setData({ lastAction: todayKey() === date && this.data.date === date ? { id, name: task.name, completed: !task.completed, date } : null });
      wx.showToast({ title: savedToast(getApp().store, task.completed ? '已撤销确认' : '今天已确认'), icon: 'none' });
      await this.refresh();
    } catch (error) { wx.showToast({ title: '保存失败，请重试', icon: 'none' }); }
    finally { this.setData({ busyId: '' }); }
  },
  async onUndoLast() {
    if (this.data.busyId || this.data.loading || this.data.refreshing || this.data.stale || !this.data.lastAction) return;
    const action = this.data.lastAction;
    this.setData({ busyId: action.id });
    try {
      if (action.date !== todayKey()) { this.setData({ lastAction: null }); await this.refresh(); return; }
      await getApp().store.setCompletion(action.id, action.date, !action.completed);
      this.setData({ lastAction: null });
      await this.refresh();
      wx.showToast({ title: savedToast(getApp().store, '已撤销刚才的操作'), icon: 'none' });
    } catch (_) { wx.showToast({ title: '撤销失败，请重试', icon: 'none' }); }
    finally { this.setData({ busyId: '' }); }
  }
});
