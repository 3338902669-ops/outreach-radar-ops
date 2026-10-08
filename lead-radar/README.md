# Lead Radar · 15 源商机扫描（可行方案，已验证）

> 状态：2026-10-06 验证通过。验证轮 15 源并行扫描 48 小时窗口，发现 8 条新商机并输出简报。
> 定位：只负责**发现和提醒**，绝不自动对外联系。投标/私信由人工用自己的平台账号操作。

## 15 个来源

| # | 源 | 类型 | 方向 |
|---|---|---|---|
| 1 | Upwork | 海外 freelance | website development / design, landing page, wordpress, webflow, figma to html, web scraping |
| 2 | V2EX | 国内社区 | jobs / freelance 节点：网站开发、前端、爬虫、自动化脚本 |
| 3 | Freelancer.com | 海外 freelance | website design / development, landing page, wordpress |
| 4 | 电鸭 | 国内远程 | 远程兼职/外包：网站开发、前端、Web 设计、小程序 |
| 5 | PeoplePerHour | 海外 freelance | website design / development, landing page |
| 6 | Guru.com | 海外 freelance | web development / design, wordpress |
| 7 | Contra | 海外 freelance | website design / development, landing page |
| 8 | We Work Remotely | 海外远程 | Programming / contract：frontend / web |
| 9 | RemoteOK | 海外远程 | frontend / web development |
| 10 | 开源众包 | 国内众包 | 悬赏项目：网站、前端、小程序 |
| 11 | 程序员客栈 | 国内众包 | 需求大厅：网站、前端、小程序 |
| 12 | 猪八戒 | 国内众包 | 需求大厅：网站建设、设计、前端 |
| 13 | Fiverr | 海外 freelance | buyer request 反向挖掘：website design / development |
| 14 | Wellfound | 海外初创 | 合同/兼职：frontend / web |
| 15 | 全网兜底 | 全网搜索 | 不限平台，定向搜索近 48h 发布的网站/前端外包需求 |

## 流水线（`lead-radar.js`）

`lead-radar.js` 是可直接加载执行的工作流脚本（15 源由 `SOURCES` 数组驱动，加源只加一行）：

1. **scan**：15 个 scout 并行（concurrency 6），每个源独立写 `scan-<key>.json`；只收录搜索返回的真实链接，严禁编造；找不到写 `[]`。
2. **dedupe**：合并 15 个文件，与历史 `lead-seen.json`（保留最近 500 条 URL）比对去重。
3. **score**：按匹配度/预算吸引力/信息可信度打 1–5 分，取前 N 条，每条配 80 字以内中文投标私信草稿。
4. **report**：生成中文简报 Markdown（含平台/链接/预算/评分/推荐理由/话术代码块）。

## 运行参数

- 每 12 小时一轮，`hoursBack: 48`，`maxLeads: 15`
- 团队可接：高端企业官网定制、落地页、品牌站动效（GSAP）、前端开发、爬虫、自动化脚本

## 验证记录

- 2026-10-06：15 源验证轮，8 条新商机。Top1：Freelancer "Sleek Website Design Needed"，$750–1500，4.3/5。
- 已知：部分源（如 Fiverr / 猪八戒）常返回空数组，由 dedupe/score 自然过滤，不影响整体。

## dry-run 说明（脱敏可复跑）

本链路**零凭据**：15 源扫描只用公开网页搜索，不需要任何 API key。
dry-run = 正常跑一轮（`hoursBack: 48, maxLeads: 15`），区别仅在于：

1. 不对外发信、不注册、不投标（雷达本来就不做这些）；
2. 跑完检查产物目录 `workspace/goals/goal/hidden_files/radar/`：
   - 18 个文件：15 个 `scan-<key>.json` + `fresh.json` + `picks.json` + `lead-seen.json` + `digest.md`；
   - `grep -rlE 'C:\\(Users|Windows)'` 应无命中（无 Windows 硬编码路径）；
   - `grep -rlE 'xkeysib|ghp_|sk-'` 应无命中（无凭据残留）。
3. 换机器时改 `RADAR_BASE_DIR`（见根目录 `.env.example`）；换运行时见
   muse-bridge `outbox/MB-005/portability-spec.md` 的 DSL 适配层规格。

最近一次 dry-run 实证：2026-10-08 18:32 CST，15 源全成功，6 条新商机，
证据见 muse-bridge `outbox/MB-005/evidence.json`。

## 与本库其他部分的关系

本目录是**商机发现**模块；本库主体的外联发信系统（SKILL.md）是**触达执行**模块。两者通过"话术草稿"衔接：发现模块只给草稿，不执行发送。
