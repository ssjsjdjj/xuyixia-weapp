'use strict';

const { calendarSlots, platformLabel, todayKey } = require('../utils/domain');
const { CALENDAR_KEY } = require('./store');

function invoke(api, method, options) {
  return new Promise((resolve, reject) => api[method](Object.assign({}, options, { success: resolve, fail: reject })));
}

function createReminders(api, config, store) {
  return {
    getStatus(task) {
      let ledger = {};
      try { ledger = api.getStorageSync(CALENDAR_KEY) || {}; } catch (_) { /* 无法读取时不推断已经设置。 */ }
      const link = task && ledger[task.id];
      const changed = !!link && (link.time !== task.time || (link.name && link.name !== task.name) || (link.type && link.type !== task.type) || (link.repeat || 'daily') !== (task.repeat || 'daily') || JSON.stringify(link.weekDays || []) !== JSON.stringify(task.weekDays || []) || (link.resumeOn || '') !== (task.resumeOn || ''));
      const temporary = task && task.resumeOn && task.resumeOn > todayKey();
      return {
        wechatConfigured: !!(config.cloudEnabled && config.subscriptionTemplateId),
        calendarAdded: !!link,
        calendarNeedsReview: !!link && (changed || task.enabled === false || temporary || link.completed === false),
        calendarHint: !link ? '尚未在本机添加日历提醒' : task.enabled === false || temporary ? '任务已暂停，原日历提醒仍需手动关闭或调整' : changed ? '任务已修改，请到手机日历调整原日程' : link.completed === false ? '只添加了部分日程，请核对后补齐' : '本机曾添加 ' + link.time + ' 日程，请到日历核对'
      };
    },
    async subscribe() {
      if (!config.cloudEnabled || !config.subscriptionTemplateId) return { status: 'unconfigured', message: '微信提醒暂未启用，可先使用手机日历提醒' };
      if (typeof api.requestSubscribeMessage !== 'function') return { status: 'error', message: '当前微信版本不支持订阅消息，请升级后重试' };
      try {
        // 在用户点击处理链中直接调用；不要在前面增加异步网络请求。
        const result = await invoke(api, 'requestSubscribeMessage', { tmplIds: [config.subscriptionTemplateId] });
        const choice = result[config.subscriptionTemplateId];
        if (choice !== 'accept' && choice !== 'acceptWithAudio') return { status: 'rejected', message: '本次未订阅，任务清单仍可正常使用' };
        try { await store.registerSubscription(config.subscriptionTemplateId, 'accept'); }
        catch (_) { return { status: 'error', message: '微信已接受订阅，但提醒计划保存失败，请联网后重新订阅' }; }
        return { status: 'accepted', message: '本次订阅已保存；一次性订阅不代表永久每天提醒' };
      } catch (_) { return { status: 'error', message: '订阅未完成，请检查微信通知设置后重试' }; }
    },
    async addCalendar(task) {
      if (!task || !task.id || task.enabled === false) return { status: 'error', message: '请先保存并启用任务' };
      if (typeof api.addPhoneRepeatCalendar !== 'function') return { status: 'error', message: '此设备暂不支持添加日历，请在手机日历手动设置' };
      const ledger = api.getStorageSync(CALENDAR_KEY) || {};
      const already = !!ledger[task.id];
      const slots = calendarSlots(task);
      const signature = JSON.stringify([task.time, task.name, task.type, task.repeat || 'daily', task.weekDays || [], task.resumeOn || '']);
      const previous = ledger[task.id];
      const continuing = previous && previous.signature === signature && previous.completed === false;
      const added = continuing ? { ...previous.slots } : {};
      let finished = 0;
      const modal = await invoke(api, 'showModal', {
        title: already ? '此任务曾添加过日历' : '添加周期日历提醒',
        content: (continuing ? '将补齐上次未添加的星期。' : already ? '继续添加可能产生重复日程。' : '') + '本次计划创建' + slots.length + '个' + (slots.length > 1 ? '每周' : slots[0].repeatInterval === 'day' ? '每日' : '每周') + '重复日程。日历不应用微信免打扰设置；完成、暂停、删除或改时后需要单独调整日历。',
        confirmText: already ? '仍然添加' : '继续添加',
        cancelText: '取消'
      });
      if (!modal.confirm) return { status: 'cancelled', message: '已取消添加' };
      try {
        if (typeof api.requirePrivacyAuthorize === 'function') await invoke(api, 'requirePrivacyAuthorize');
        if (typeof api.authorize === 'function') await invoke(api, 'authorize', { scope: 'scope.addPhoneCalendar' });
        for (const slot of slots) {
        if (added[slot.key]) { finished++; continue; }
        await invoke(api, 'addPhoneRepeatCalendar', {
          title: '续一下 · ' + platformLabel(task.type) + ' · ' + task.name,
          startTime: slot.startTime,
          allDay: false,
          description: '请在' + (task.type === 'weibo' ? '微博完成打卡' : '抖音完成互动') + '，再到“续一下”确认。此日程由手机日历独立管理。',
          alarm: true,
          alarmOffset: 0,
          repeatInterval: slot.repeatInterval
        });
        added[slot.key] = true; finished++;
        ledger[task.id] = { time: task.time, name: task.name, type: task.type, repeat: task.repeat || 'daily', weekDays: task.weekDays || [], resumeOn: task.resumeOn || '', signature, slots: added, completed: finished === slots.length, addedAt: new Date().toISOString() };
        try { api.setStorageSync(CALENDAR_KEY, ledger); } catch (_) { /* 日程已写入，勿因此提示重试导致重复。 */ }
        }
        return { status: 'added', message: '已添加日历日程，请检查手机日历通知是否开启' };
      } catch (error) {
        if (finished) return { status: 'partial', message: '已有' + finished + '/' + slots.length + '个日程添加成功。请先到日历核对，避免重复添加；下次可补齐未完成部分。' };
        const message = error && error.errMsg || '';
        return { status: /cancel/.test(message) ? 'cancelled' : 'error', message: '未添加日历，请在微信设置中检查日历权限，或手动创建' };
      }
    }
  };
}

module.exports = { createReminders };
