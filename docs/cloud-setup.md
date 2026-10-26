# 云开发配置与部署

现在没有账号时，可以保持本地模式体验核心功能。本文件用于以后启用云端保存和微信提醒，当前代码没有部署、没有真实发送过通知。

## 准备账号与环境

取得微信小程序 AppID，使用适合实际业务的服务类目，开通云开发环境。在微信公众平台选择获准的订阅消息模板，确认该模板允许用于实际提醒场景。缺少合适模板时保持本地／日历方案，不借用无关类目的通知能力。

修改项目根目录 `project.config.json` 的 AppID。在微信开发者工具中选择对应云环境。小程序端只填写 AppID、环境ID和模板ID；不要放 AppSecret、服务端访问凭证或 access_token。

## 创建数据库集合

在同一个环境创建以下集合，全部设为仅云函数可读写，客户端数据库安全规则为：

```json
{ "read": false, "write": false }
```

| 集合 | 内容 |
| --- | --- |
| xyx_tasks | owner、任务内容、启用状态、删除标记 |
| xyx_records | owner、任务ID、北京时间日期、名称快照、确认时间 |
| xyx_settings | owner、默认时间、任务数量、清空状态 |
| xyx_subscriptions | owner、模板ID、客户端授权结果线索 |
| xyx_deliveries | owner、日期、时点、发送占位及结果 |
| xyx_mutations | 离线操作唯一ID、内容摘要、幂等回执与版本 |
| xyx_joints | 共同任务名称、平台、双方成员和有效状态 |
| xyx_invitations | 邀请令牌摘要、共同任务ID、版本与过期时间 |
| xyx_joint_records | 当前确认者、共同任务ID、日期与确认时间 |

API使用平台 `getWXContext().OPENID` 获取身份，拒绝请求中指定 owner 或 OPENID。客户端不直接连接这些集合。

建议按实际查询建立索引：任务 `owner + _id`、任务 `enabled + _id`、记录 `owner + _id`、订阅与发送账本 `owner + _id`。具体以控制台索引提示和数据规模为准，`_id` 保留唯一索引。当前按100条分页，属于初版的小规模扫描设计；大规模运营前应改为按下一次触发时间索引与分片调度，并制定历史账本保留策略。

## 部署API函数

右击 `cloudfunctions/xuyixia-api`，选择「上传并部署：云端安装依赖」。代码固定使用 `wx-server-sdk@4.0.2`，选用当前环境可用且满足 Node.js 18 或以上的运行时。云函数环境变量设置：

```text
TEMPLATE_ID=本主体获准的订阅模板ID
```

API只通过微信小程序调用，保持函数调用权限受控。不要为两个函数开启匿名HTTP访问或公共函数URL。

## 配置提醒函数

修改 `cloudfunctions/xuyixia-remind/reminder.config.json`。默认 `enabled:false`，空模板或空字段映射时不发送。字段名必须从自己的获准模板复制，以下只是映射格式示例，不能直接当作有效模板：

```json
{
  "enabled": true,
  "templateId": "获准模板ID",
  "templateFields": {
    "thing1": "title",
    "time2": "time",
    "thing3": "summary"
  },
  "page": "pages/today/index",
  "miniprogramState": "developer",
  "maxDelayMinutes": 15
}
```

值来源包括：`title` 提醒标题、`summary` 对象摘要、`name` 首个对象、`platform` 平台、`time` 日期时间、`date` 日期、`count` 数量、`status` 待确认。代码按字段类型截断长度，但不能替代对模板业务含义和实际允许格式的核对。

提醒函数支持环境变量覆盖：`REMINDER_ENABLED=true`、`TEMPLATE_ID`、`TEMPLATE_FIELDS_JSON`、`MINIPROGRAM_STATE` 和 `REMINDER_MAX_DELAY_MINUTES`。API的 `TEMPLATE_ID` 必须与提醒函数和客户端一致。正式发布时把 `miniprogramState` 改为 `formal`，体验版用 `trial`。

上传 `xuyixia-remind` 并云端安装依赖。随附 `config.json` 声明 `subscribeMessage.send` 权限及每分钟触发器：

```json
{ "name": "xuyixiaEveryMinute", "type": "timer", "config": "0 * * * * * *" }
```

在控制台核对触发器已创建且启用，名称须与代码一致。部分部署方式只上传代码，不自动应用触发器，需要在控制台另行配置。七段表达式按秒、分、时、日、月、星期、年解释；业务日期统一转换为北京时间。[CloudBase定时触发说明](https://docs.cloudbase.net/cloud-function/timer-trigger)

提醒函数拒绝来自小程序的 OPENID／客户端来源调用，只接受匹配定时事件或有权限的云端运维调用。事件中的 `Type` 和 `TriggerName` 不能单独作为认证依据，平台调用权限与可信上下文同样必要。

## 切换客户端

修改 `miniprogram/config.js`：

```js
module.exports = {
  storageMode: 'cloud',
  cloudEnvId: '你的环境ID',
  apiFunctionName: 'xuyixia-api',
  subscriptionTemplateId: '同一个获准模板ID'
};
```

重新编译。此操作不自动迁移本机任务，云端初始清单为空。先用自己的测试任务，设置几分钟后的时间，点击「申请微信消息提醒」并允许，再在真机检查函数日志、发送账本和微信服务通知。

## 提醒行为与故障处理

- 同一用户、同一北京时间日期、同一提醒时点合并为一组。已确认、暂停或删除的任务会在发送前再次检查。
- 一次性订阅需要用户主动选择。服务器保存的是客户端报告的授权线索，不是可向微信核验的余额，不展示“剩余提醒次数”。伪造线索不能获得真实发送权限，微信仍会校验。[腾讯云订阅说明](https://cloud.tencent.com/document/product/1301/103770)
- 事务占位避免并发扫描重复发送。`claimed` 为占位、`submitted` 为微信接口接受、`failed` 为明确拒绝、`unknown` 为结果不确定、`suppressed` 为发前条件变化。这些均不证明用户已读或已操作。
- 外部接口与数据库之间无法保证严格“恰好一次”。已有占位不自动重发；崩溃或网络不确定时可能漏发。运维应检查账本，不要直接删掉旧占位重发。
- 默认最多补扫当前日15分钟内的到期组，不补发昨日任务。修改暂停状态到接口发送之间仍可能有极短竞态窗口。
- 清空云数据时先写标记，阻止新写入和新发送。中断后五分钟可在设置页重试；已在外部发送中的请求无法撤回。清空不影响独立保存的手机日历。

## 部署后实测

验证两个微信用户互不可见；未订阅时不发送；拒绝授权仍可用清单；同一时点只产生一组占位；提前确认、暂停、删除会跳过；模板错误标为失败；成功不显示“已读”；清空失败可重试；跨北京时间零点使用新日期。

套餐、配额和可用运行时以账号控制台为准，此源码不包含付费资源创建或上线操作。

## 0.3.0 新增部署与验收

升级时重新部署两个函数，并创建以上新增的4个集合，规则同样禁止客户端直读写。建议增加共同任务 `owner + _id`、`guest + _id`，邀请和双方记录 `jointId + _id`，操作回执与双方记录 `owner + _id` 的索引，按控制台提示调整。

前端与两个函数的周期／免打扰规则来自同一份 `miniprogram/utils/policy.js`，修改后运行 `npm run policy:sync`，再重新部署两个函数。不要只更新前端，以免界面和实际发送计划不一致。

云模式使用 `getSession` 验证用户数据空间、`getSnapshot` 获取快照、`commitOffline` 原子提交离线操作。客户端始终由云端OPENID确定所有者，服务器验证操作版本并保留幂等回执。当前没有配置回执自动过期；在确定没有旧离线队列会重试前，不应手动删除这些回执。

验收需增加：周一至周五与自选星期不在其他日期发送；暂停一周的恢复边界；同一用户每日汇总只产生一组；免打扰时不发送、不补发；网络恢复后待同步操作按顺序上传且回执重试不重复创建；其他设备改动产生冲突；其他设备清空后旧队列不会重建任务。

共同任务需分别用两个真实微信用户测试：生成24小时邀请，通过原生分享入口选择好友；未同意前不成为成员；第三个用户不能加入或读取双方状态；双方只能确认自己；邀请轮换和过期有效；退出或清空后资格撤销。源代码和浏览器模拟不能证明分享或通知已经成功送达。

离线修改尚未同步时，云端仍按原计划执行提醒。共同任务不进入离线操作队列；私人提醒和订阅权限由双方分别设置。详细使用规则见 `release-0.3.0.md`。
