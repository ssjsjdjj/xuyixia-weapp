const { todayKey, shiftDate, formatDateLabel, platformLabel } = require('../../utils/domain');
const { syncMessage, savedToast } = require('../../utils/sync-ui');

Page({
  data: { date: '', today: '', dateLabel: '', records: [], loading: true, loadError: false, busyId: '', syncMessage: '' },
  onLoad() { const today = todayKey(); this.setData({ date: today, today }); },
  onShow() { this.setData({ today: todayKey() }); this.refresh(); },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  async refresh() {
    const requestId = this._refreshId = (this._refreshId || 0) + 1;
    const date = this.data.date || todayKey();
    this.setData({ loading: true, loadError: false, date, dateLabel: formatDateLabel(date) });
    try {
      const records = await getApp().store.listRecords({ date });
      if (requestId !== this._refreshId) return;
      this.setData({ records: records.map(item => ({ ...item, platformLabel: platformLabel(item.type), avatar: Array.from(item.name || '续')[0], timeLabel: this.timeLabel(item.completedAt) })), syncMessage: syncMessage(getApp().store) });
    } catch (error) { if (requestId === this._refreshId) { this.setData({ loadError: true }); wx.showToast({ title: '记录未能加载', icon: 'none' }); } }
    finally { if (requestId === this._refreshId) this.setData({ loading: false }); }
  },
  timeLabel(value) { const millis = new Date(value).getTime(); return Number.isNaN(millis) ? '' : `${new Date(millis + 8 * 60 * 60 * 1000).toISOString().slice(11, 16)} 确认`; },
  onDate(event) { this.setData({ date: event.detail.value }); this.refresh(); },
  onPrevious() { if (this.data.loading || this.data.busyId) return; this.setData({ date: shiftDate(this.data.date, -1) }); this.refresh(); },
  onNext() { if (this.data.loading || this.data.busyId || this.data.date >= this.data.today) return; this.setData({ date: shiftDate(this.data.date, 1) }); this.refresh(); },
  onToday() { this.setData({ date: todayKey() }); this.refresh(); },
  onGoToday() { wx.switchTab({ url: '/pages/today/index' }); },
  async onUndo(event) {
    if (this.data.busyId) return;
    const id = event.currentTarget.dataset.id;
    this.setData({ busyId: id });
    try { await getApp().store.setCompletion(id, this.data.date, false); wx.showToast({ title: savedToast(getApp().store, '已撤销这次确认'), icon: 'none' }); await this.refresh(); }
    catch (error) { wx.showToast({ title: '撤销失败，请重试', icon: 'none' }); }
    finally { this.setData({ busyId: '' }); }
  }
});
