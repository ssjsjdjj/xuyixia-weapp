const { validateTask } = require('../../utils/domain');
const { savedToast } = require('../../utils/sync-ui');

Page({
  data: { id: '', type: 'douyin', name: '', time: '21:00', note: '', greeting: '今天也来续一下，记得照顾好自己。', enabled: true, repeat: 'daily', weekDays: [], weekOptions: [], pinned: false, resumeOn: '', copying: false, errors: {}, loading: true, busy: false },
  async onLoad(options) {
    const id = options.id || '';
    this.setData({ id });
    if (id) wx.setNavigationBarTitle({ title: '编辑任务' });
    try {
      if (id || options.copyFrom) {
        const task = await getApp().store.getTask(id || options.copyFrom);
        if (!task) { wx.showToast({ title: '这件小事已不存在', icon: 'none' }); this.setData({ unavailable: true }); return; }
        this.setData({ type: task.type, name: id ? task.name : '', time: task.time, note: task.note || '', greeting: task.greeting || '', enabled: id ? task.enabled : true, repeat: task.repeat || 'daily', weekDays: task.weekDays || [], pinned: id ? !!task.pinned : false, resumeOn: id ? task.resumeOn || '' : '', copying: !id });
      } else {
        const settings = await getApp().store.getSettings();
        this.setData({ time: settings.defaultReminderTime || '21:00' });
        if (options.title) { let name = options.title; try { name = decodeURIComponent(name); } catch (_) {} this.setData({ name, type: options.type === 'weibo' ? 'weibo' : 'douyin' }); }
      }
      this.updateWeekOptions();
    } catch (error) { wx.showToast({ title: '读取失败，请返回重试', icon: 'none' }); this.setData({ unavailable: true }); }
    finally { this.setData({ loading: false }); }
  },
  onType(event) {
    const type = event.currentTarget.dataset.type;
    const patch = { type, errors: {} };
    if (this.data.greeting === '今天也来续一下，记得照顾好自己。' || this.data.greeting === '') patch.greeting = type === 'douyin' ? '今天也来续一下，记得照顾好自己。' : '';
    this.setData(patch);
  },
  onInput(event) { this.setData({ [event.currentTarget.dataset.field]: event.detail.value, errors: {} }); },
  onTime(event) { this.setData({ time: event.detail.value, errors: {} }); },
  onEnabled(event) { this.setData({ enabled: event.detail.value }); },
  onPinned(event) { this.setData({ pinned: event.detail.value }); },
  onRepeat(event) { this.setData({ repeat: event.currentTarget.dataset.repeat, errors: {} }); this.updateWeekOptions(); },
  updateWeekOptions() { this.setData({ weekOptions: [1,2,3,4,5,6,7].map(day => ({ day, label: '一二三四五六日'[day-1], selected: this.data.weekDays.includes(day) })) }); },
  onWeekDay(event) { const day = Number(event.currentTarget.dataset.day); this.setData({ weekDays: this.data.weekDays.includes(day) ? this.data.weekDays.filter(value => value !== day) : [...this.data.weekDays, day], errors: {} }); this.updateWeekOptions(); },
  async onSave() {
    if (this.data.busy || this.data.loading || this.data.unavailable) return;
    const result = validateTask({ id: this.data.id || undefined, type: this.data.type, name: this.data.name, time: this.data.time, note: this.data.note, greeting: this.data.greeting, enabled: this.data.enabled, repeat: this.data.repeat, weekDays: this.data.weekDays, pinned: this.data.pinned, resumeOn: this.data.resumeOn });
    if (!result.valid) { this.setData({ errors: result.errors }); wx.showToast({ title: '请检查填写内容', icon: 'none' }); return; }
    this.setData({ busy: true });
    try {
      if (!this.data.id) {
        const tasks = await getApp().store.listTasks({ includePaused: true });
        const duplicate = tasks.some(task => task.type === result.value.type && task.name.toLowerCase() === result.value.name.toLowerCase());
        if (duplicate) {
          const confirmed = await new Promise(resolve => wx.showModal({ title: '已有同名任务', content: '清单中已有同平台、同名称的任务。仍要再添加一条吗？', confirmText: '仍然添加', cancelText: '返回检查', success: answer => resolve(answer.confirm), fail: () => resolve(false) }));
          if (!confirmed) return;
        }
      }
      const task = await getApp().store.saveTask({ ...result.value, ...(this.data.id ? { id: this.data.id } : {}) });
      wx.showToast({ title: savedToast(getApp().store, '任务已保存'), icon: 'none' });
      if (!this.data.id) {
        wx.redirectTo({ url: `/pages/task-detail/index?id=${encodeURIComponent(task.id)}&created=1`, fail: () => wx.switchTab({ url: '/pages/today/index' }) });
      } else {
        const pages = getCurrentPages();
        if (pages.length > 1) wx.navigateBack(); else wx.switchTab({ url: '/pages/today/index' });
      }
    } catch (error) { wx.showToast({ title: '保存失败，请重试', icon: 'none' }); }
    finally { this.setData({ busy: false }); }
  }
});
