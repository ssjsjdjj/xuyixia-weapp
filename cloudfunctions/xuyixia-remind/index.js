'use strict';

const { createRepository } = require('./repository');
const { createReminder, loadConfig, allowedTrigger } = require('./service');

exports.main = async (event) => {
  const cloud = require('wx-server-sdk');
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV, throwOnNotFound: false });
  const wxContext = cloud.getWXContext();
  // Type/TriggerName alone are not authentication. A client can forge event fields;
  // OPENID/SOURCE come from the platform and must be checked first.
  if (!allowedTrigger(event, wxContext)) {
    return { ok: false, error: { code: 'FORBIDDEN', message: '此函数仅供定时触发和受信任的云端运维调用' } };
  }
  try {
    const config = loadConfig(process.env, require('./reminder.config.json'));
    const run = createReminder({
      repo: createRepository(cloud.database({ throwOnNotFound: false })),
      config,
      send: message => cloud.openapi.subscribeMessage.send(message)
    });
    return { ok: true, data: await run() };
  } catch (error) {
    console.error('xuyixia-remind failure', { code: error && (error.code || error.errCode) || 'INTERNAL' });
    return { ok: false, error: { code: 'REMINDER_FAILED', message: '提醒任务执行失败，请查看受控云日志' } };
  }
};
