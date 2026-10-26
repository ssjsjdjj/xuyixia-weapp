function syncMessage(store) {
  const status = typeof store.getSyncStatus === 'function' ? store.getSyncStatus() : {};
  return status.conflict ? '有同步冲突，本机修改已保留，请到设置处理。' : status.pendingCount ? '有' + status.pendingCount + '项修改待同步，云端仍按原计划提醒。' : status.offline ? '正在查看本机缓存，联网后可刷新。' : '';
}
function savedToast(store, normal) { return syncMessage(store) ? '已保存在本机，待同步' : normal; }
module.exports = { syncMessage, savedToast };
