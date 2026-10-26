const rawConfig = require('./config');
const { createStore } = require('./services/store');
const { createReminders } = require('./services/reminders');

App({
  onLaunch() {
    const config = Object.assign({}, rawConfig);
    config.cloudEnabled = config.storageMode === 'cloud' && !!config.cloudEnvId && !!wx.cloud;
    this.config = config;
    if (config.cloudEnabled) {
      wx.cloud.init({ env: config.cloudEnvId, traceUser: false });
    }
    this.store = createStore(wx, config);
    this.reminders = createReminders(wx, config, this.store);
    if (typeof wx.onNetworkStatusChange === 'function') wx.onNetworkStatusChange(status => {
      if (this.store.setNetworkAvailable) this.store.setNetworkAvailable(status.isConnected);
      if (status.isConnected && config.storageMode === 'cloud') this.store.syncNow().catch(() => {});
    });
  },
  onShow() {
    if (this.config && this.config.storageMode === 'cloud' && this.store) this.store.syncNow().catch(() => {});
  }
});
