// 默认本地版可直接体验。云版部署步骤见 docs/cloud-setup.md。
module.exports = {
  storageMode: 'local', // local | cloud；切换模式不会自动迁移数据
  cloudEnvId: '',
  apiFunctionName: 'xuyixia-api',
  subscriptionTemplateId: '' // 与云端 TEMPLATE_ID 一致，须为本主体获准模板
};
