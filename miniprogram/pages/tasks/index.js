const { todayKey, decorateTasks } = require('../../utils/domain');
const { syncMessage } = require('../../utils/sync-ui');
Page({
  data: { tasks: [], visible: [], query: '', loading: true, message: '' },
  onShow() { this.refresh(); },
  async refresh() {
    this.setData({ loading: true });
    try { const tasks = await getApp().store.listTasks({ includePaused: true }); this.setData({ tasks: decorateTasks(tasks, [], todayKey()), message: syncMessage(getApp().store) }); this.filter(); }
    catch (_) { wx.showToast({ title: '任务未加载，请联网后重试', icon: 'none' }); }
    finally { this.setData({ loading: false }); }
  },
  filter() { const q = this.data.query.trim().toLowerCase(); this.setData({ visible: this.data.tasks.filter(task => !q || task.name.toLowerCase().includes(q)) }); },
  onSearch(event) { this.setData({ query: event.detail.value }); this.filter(); },
  onDetail(event) { wx.navigateTo({ url: '/pages/task-detail/index?id=' + encodeURIComponent(event.currentTarget.dataset.id) }); },
  onCreate() { wx.navigateTo({ url: '/pages/task-form/index' }); }
});
