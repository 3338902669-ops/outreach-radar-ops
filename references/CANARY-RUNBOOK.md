# CANARY-RUNBOOK · 单封实发实验（别人可复跑）

> 来源：muse-bridge MB-006，2026-10-06 实测通过。目的：验证 Brevo 真实投递通道（建信 → 投递 → 打开追踪）完整闭环。
> 铁律：**收件人只允许一个硬编码常量（实验者自有邮箱），全程最多 1 封，凭据只从环境变量读，用完即清。**

## 前置条件

- Brevo 账号下有一个**已验证的 sender 身份**（实验用 `hello@morphostech.com`）。
- 一把**临时** Brevo API key（实验后即吊销），以环境变量 `BREVO_KEY` 传入，**绝不写入文件**。

## 步骤

1. **dry-run**：`node canary-send.mjs --dry-run`
   - 期望：退出码 0，打印收件人/发件人/主题，`sends: 0`，不调用任何 API。
   - 检查收件人是否为硬编码常量（脚本内 `RECIPIENT`），不得参数化。
2. **真实发送**（仅 1 次）：
   ```bash
   BREVO_KEY='<临时key>' node canary-send.mjs
   ```
   - 期望：退出码 0，Brevo 返回 **HTTP 201** 并给出 `messageId`。
   - 若非 201：**不得重试轰炸**，记录原始响应后停止。
3. **事件查询**（发送数分钟后）：
   ```bash
   curl -H "api-key: $BREVO_KEY" \
     "https://api.brevo.com/v3/smtp/statistics/events?messageId=<urlencode后的messageId>"
   ```
   - 刚发送完查到空属正常；打开事件需收件人实际打开邮件后产生。
4. **凭据清理**：
   - 确认 key 只存在于命令环境变量（新 shell 即消失）。
   - 跑泄漏检查：`grep -r "<key 的独特片段>" outbox/MB-006/` → 必须无命中。
   - 在报告中给出清理确认。
5. **收尾**：收件人确认收到邮件后，**立刻在 Brevo 后台吊销该临时 key**。

## 脚本要点（canary-send.mjs）

- `RECIPIENT` / `SENDER` 为文件顶部硬编码常量。
- `--dry-run` 分支在任何网络调用之前退出。
- key 缺失时 `process.exit(2)`，不打印 key。
- 发送 body 打 `tags: ['mb006-canary']` 便于后台过滤。

## 失败模式

| 现象 | 处理 |
|---|---|
| HTTP 401 | key 无效或已吊销 → 停止，找实验发起人换 key |
| HTTP 400（sender 未验证） | 换已验证 sender → 但收件人仍必须是白名单常量 |
| 事件接口长期为空 | 以 201 + messageId 为发送成功判据；打开追踪以后台为准 |
| 任何一步想改收件人 | **立即停止**，这是红线 |

## 与 dry-run 链的关系

MB-005 的 dry-run 验证的是整链可移植性；本 runbook 验证的是真实投递通道。顺序：先整链 dry-run，再本 canary。
