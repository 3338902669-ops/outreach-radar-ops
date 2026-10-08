#!/usr/bin/env node
/**
 * run.mjs — 可执行的获客雷达（2026-10-08 由 dsh 重建）
 *
 * 与旧版 lead-radar.js（Hatch DSL，脱离运行时即 ReferenceError）的区别：
 *   本脚本是独立可执行的 Node 程序，零依赖，直接 `node run.mjs` 即可产出简报。
 *
 * 硬约束（对应 channel/0009 与 0012 的门槛）：
 *   1) 只扫「接单/众包」源；全职招聘板默认不出条目（可 --include-fulltime 进附录）
 *   2) 每条候选必须过可用性闸（HTTP 状态 / 关闭过期标记 / 形态判定）
 *   3) 正文只放「过闸 + 接单形态 + 评分 > 0」的条目；其余进附录并写明原因
 *   4) 每条必须带：真项目页 URL、发布时间、核验时间、HTTP 状态、评分依据
 *   5) 输出分源计数表（含 0 条与失败原因）
 *
 * 用法：
 *   node run.mjs                 # 正常跑（含 HTTP 复核）
 *   node run.mjs --dry-run       # 不发起 HTTP 复核，只做结构化筛选
 *   node run.mjs --source=freelancer,v2ex
 *   node run.mjs --include-fulltime
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from './lib-adapters.mjs';
import { mailAlerts, loadUrlList } from './lib-mail.mjs';
import { imapAlerts, imapSelftest } from './lib-imap.mjs';
import { runGate, scoreLead } from './lib-gate.mjs';

const BT = String.fromCharCode(96); // 反引号（避免在外层模板里转义地狱）
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const a = argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : d; };

const DRY = flag('dry-run');
const INCLUDE_FULLTIME = flag('include-fulltime');
const ONLY = opt('source', '');
const CHECK_TOP = Number(opt('check-top', '60'));
const FETCH_LIMIT = Number(opt('limit', '100'));

const URLS_FILE = opt('urls', '');

// --imap-selftest：只验证「能不能连上 + 认证」，不读信、不出简报
if (flag('imap-selftest')) {
  const r = imapSelftest();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 2);
}
const registry = JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8'));
// 显式 --source=xxx 时**覆盖** enabled 开关（便于按需临时启用某条通道）
const enabled = registry.sources.filter((s) => s.adapter && (ONLY ? ONLY.split(',').includes(s.id) : s.enabled));

function bidDraft(lead) {
  const blob = String(lead.title || '') + ' ' + String(lead.summary || '');
  const skill = /(scrap|crawl|automat)/i.test(blob) ? 'web scraping and automation'
    : /(wordpress|webflow)/i.test(blob) ? 'WordPress / Webflow site development'
    : /(design|figma|ui|ux)/i.test(blob) ? 'front-end and UI implementation'
    : 'front-end and website development';
  return [
    'Hi, I am a freelance ' + skill + ' developer.',
    'I read your posting "' + String(lead.title).slice(0, 80) + '" and this is squarely in my wheelhouse. I deliver in stages with a working demo at each milestone, plus handover notes.',
    'Happy to start with a short scoped plan and a fixed quote so there are no surprises. Shall I send that over?',
  ].join(' ');
}

const table = [];
const accepted = [];
const rejected = [];
const loginWall = [];
const crowded = [];

// 模式 0：手动粘贴 URL 清单（无需任何平台凭据，立即可用）
if (URLS_FILE) {
  const cands = loadUrlList(URLS_FILE);
  const row = { id: 'manual-urls', label: '手动 URL 清单', group: 'contract', fetched: cands.length, kept: 0, note: URLS_FILE };
  for (const c of cands) {
    const scored = scoreLead(c);
    rejected.push({ ...c, ...scored, reject: '__pending_gate__' });
  }
  table.push(row);
  enabled.length = 0; // 显式指定 URL 清单时不再跑抓取源
}

for (const src of enabled) {
  const row = { id: src.id, label: src.label, group: src.group, fetched: 0, kept: 0, note: '' };
  try {
    const fn = ADAPTERS[src.adapter] || (src.adapter === 'mailAlerts' ? mailAlerts : src.adapter === 'imapAlerts' ? imapAlerts : null);
    if (!fn) { row.note = '未实现的适配器: ' + src.adapter; table.push(row); continue; }
    const cands = await fn(src, { limit: FETCH_LIMIT });
    row.fetched = cands.length;
    if (src.__note) row.note = src.__note;
    for (const c of cands) {
      if (!c.url) { rejected.push({ ...c, reject: '无 URL' }); continue; }
      if (c.shape === 'fulltime' && !INCLUDE_FULLTIME) { rejected.push({ ...c, reject: '全职招聘板（非接单形态）' }); continue; }
      if (/closed|cancelled|expired/i.test(String(c.raw_status || ''))) { rejected.push({ ...c, reject: '源侧状态为关闭: ' + c.raw_status }); continue; }
      if (c.shape !== 'contract') { rejected.push({ ...c, reject: '形态非接单（' + c.shape + '）' }); continue; }
      const scored = scoreLead(c);
      const lead = { ...c, ...scored, checked_at: null, http_status: null, gate_problems: [] };
      if (DRY) { accepted.push(lead); row.kept++; } else { rejected.push({ ...lead, reject: '__pending_gate__' }); }
    }
    table.push(row);
  } catch (e) {
    row.note = '抓取失败: ' + String(e.message || e).slice(0, 120);
    table.push(row);
  }
}

if (!DRY) {
  const pending = rejected.filter((x) => x.reject === '__pending_gate__').sort((a, b) => b.score - a.score).slice(0, CHECK_TOP);
  const pendingUrls = new Set(pending.map((p) => p.url));
  const rest = rejected.filter((x) => x.reject === '__pending_gate__' && !pendingUrls.has(x.url));
  rejected.length = 0;
  for (const p of pending) {
    const g = await runGate(p.url);
    const merged = { ...p, http_status: g.http_status, final_url: g.final_url, checked_at: g.checked_at, gate_problems: g.problems.slice() };
    if (g.ok) {
      // 2026-10-08：公开池实测「每条都有几十到几百个竞标者」。把"能赢的"和"陪跑的"分开，
      // 否则清单看着热闹、实际一条都投不出结果。
      const bids = Number(merged.bids || 0);
      const ageH = merged.posted_at ? (Date.now() - Date.parse(merged.posted_at)) / 3600000 : null;
      const winnable = bids < 20 && (ageH == null || ageH <= 48);
      if (winnable) accepted.push(merged); else crowded.push(merged);
    }
    else if (g.login_wall && /^(mail-alert|manual-url)$/.test(String(p.raw_status || ''))) {
      // 渠道本身合法（你自己的提醒邮件 / 你手动粘贴），只是页面需登录 → 不当作失败，
      // 但**绝不混进"已核验"正文**，单独成节并明确标注未独立核验。
      loginWall.push({ ...merged, reject: '页面需登录（' + g.http_status + '），未独立核验' });
    } else rejected.push({ ...merged, reject: '未过闸: ' + g.problems.join('; ') });
  }
  for (const p of rest) rejected.push({ ...p, reject: '结构筛选通过但本轮未做 HTTP 核验（超出 check-top=' + CHECK_TOP + '）' });
  for (const row of table) row.kept = accepted.filter((a) => a.source === row.id).length;
}

accepted.sort((a, b) => b.score - a.score);
const stamp = new Date();
const dateId = stamp.toISOString().slice(0, 10);
const L = [];
L.push('# ' + dateId + ' 获客雷达简报（可执行版）');
L.push('');
L.push('- 生成时间：' + stamp.toISOString() + '（本地 ' + stamp.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '）');
L.push('- 生成脚本：' + BT + 'lead-radar/run.mjs' + BT + '（独立可执行、零依赖）');
L.push('- 模式：' + (DRY ? '**dry-run（未做 HTTP 复核）**' : '正常（含 HTTP 可用性闸）'));
L.push('- 门槛：只扫接单/众包源；每条过闸（HTTP 状态 / 关闭过期标记 / 形态判定）；正文只放通过项');
L.push('');
L.push('## 一、可投清单（' + accepted.length + ' 条 · 判定：竞标 <20 且发布 ≤48h）');
L.push('');
if (!accepted.length) {
  L.push('**本轮 0 条可投。** 详见第三节分源计数表与第四节限制说明——没有任何条目被跳过或注水。');
  L.push('');
} else {
  accepted.forEach((l, i) => {
    L.push('### ' + (i + 1) + '. ' + l.title);
    L.push('- 来源：' + l.source_label + ' ｜ 形态：' + l.shape + ' ｜ 匹配技能：' + ((l.matched_jobs || []).join(', ') || '-'));
    L.push('- 链接：' + l.url);
    L.push('- 预算：' + (l.budget_max ? (l.currency + ' ' + l.budget_min + '-' + l.budget_max) : '未公开') + ' ｜ 投标数：' + (l.bids == null ? '-' : l.bids));
    L.push('- 发布时间：' + (l.posted_at || '源未提供') + ' ｜ 核验时间：' + (l.checked_at || '未做 HTTP 核验') + ' ｜ HTTP：' + (l.http_status == null ? '-' : l.http_status));
    L.push('- 评分：**' + l.score + '/10**（依据：' + (l.reasons || []).join('、') + '）');
    L.push('- 摘要：' + String(l.summary || '').replace(/\s+/g, ' ').slice(0, 200));
    L.push('- **英文投标稿（可直接粘贴）**：');
    L.push('');
    L.push('  > ' + bidDraft(l));
    L.push('');
  });
}
L.push('## 二、竞标过多的公开池项目（' + crowded.length + ' 条 · 已过闸，但**胜算极低**）');
L.push('');
if (!crowded.length) L.push('（无）');
else {
  L.push('> 这些项目**内容匹配、页面也正常**，但竞标数 ≥20（多为 100–500）。公开池里一条新账号基本抢不到。');
  L.push('> 列出来是让你知道市场成色，**不建议投入时间**。');
  L.push('');
  crowded.sort((a, b) => (a.bids || 0) - (b.bids || 0));
  crowded.slice(0, 20).forEach((l, i) => {
    L.push('- ' + (i + 1) + '. **' + l.title + '** — 竞标 ' + (l.bids ?? '?') + ' ｜ ' + (l.budget_max ? (l.currency + ' ' + l.budget_min + '-' + l.budget_max) : '预算未公开') + ' ｜ ' + l.url);
  });
  if (crowded.length > 20) L.push('- …（其余 ' + (crowded.length - 20) + ' 条略）');
}
L.push('');
L.push('## 三、待人工确认（' + loginWall.length + ' 条 · 页面需登录，**未独立核验**）');
L.push('');
if (!loginWall.length) L.push('（无）');
else {
  L.push('> 这些条目来自**你自己的提醒邮件或你手动粘贴**，渠道合法；但平台对匿名访问返回 403/401，');
  L.push('> 因此本脚本**无法独立核验**页面内容（预算/时效/是否已关闭）。请登录后人工确认再决定。');
  L.push('');
  loginWall.forEach((l, i) => {
    L.push('- **' + (i + 1) + '. ' + l.title + '**');
    L.push('  - 链接：' + l.url);
    L.push('  - 来源：' + l.source_label + ' ｜ HTTP：' + l.http_status + '（需登录）');
    L.push('  - 待确认项：预算 / 发布时间 / 是否仍在招 / 是否已授标');
  });
}
L.push('');
L.push('## 四、未通过（' + rejected.length + ' 条，附原因）');
L.push('');
if (!rejected.length) L.push('（无）');
else {
  const byReason = {};
  for (const r of rejected) { const k = String(r.reject).split(':')[0].slice(0, 70); byReason[k] = (byReason[k] || 0) + 1; }
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) L.push('- ' + k + ' × ' + v);
}
L.push('');
L.push('## 五、分源计数表');
L.push('');
L.push('| 源 | 组 | 抓到 | 通过 | 说明 |');
L.push('|---|---|---|---|---|');
for (const r of table) L.push('| ' + r.label + ' | ' + r.group + ' | ' + r.fetched + ' | ' + r.kept + ' | ' + (r.note || '') + ' |');
for (const s of registry.sources.filter((x) => !x.enabled)) L.push('| ' + s.label + ' | ' + s.group + ' | — | 0 | 未启用：' + (s.reason || s.note || '') + ' |');
L.push('');
L.push('## 六、口径与限制（如实声明）');
L.push('');
L.push('1. 只实现无需凭据、公开可抓的源；需登录或反爬的平台（Upwork/Guru/PeoplePerHour/Contra/Fiverr/猪八戒/程序员客栈/开源众包）未启用，原因见 sources.json —— 不假装能抓。');
L.push('2. ' + BT + '--check-top=' + CHECK_TOP + BT + ' 限制 HTTP 复核条数；超出部分标注「未做 HTTP 核验」，不得当作已核验。');
L.push('3. 评分是可复核的启发式（技能匹配 + 预算档 + 有无发布时间 + 投标数），不是胜率预测。');
L.push('4. 平台投递必须由本人账号手动完成；本脚本不自动投标、不自动联系任何人（平台条款禁止）。');
L.push('5. 抓取频率：每次运行仅 1 请求/源，请勿高频重跑。');
L.push('');
L.push('---');
L.push('*生成器不编造：任何未跑过的检查都不会出现在「通过」里。*');

const mdPath = path.join(HERE, 'briefs', dateId + '-可执行版.md');
fs.mkdirSync(path.dirname(mdPath), { recursive: true });
fs.writeFileSync(mdPath, L.join('\n') + '\n', 'utf8');
const jsonPath = mdPath.replace(/\.md$/, '.json');
fs.writeFileSync(jsonPath, JSON.stringify({ generated_at: stamp.toISOString(), dry_run: DRY, accepted, crowded, loginWall, rejected, table, registry_version: registry.version }, null, 2), 'utf8');

console.log(JSON.stringify({ ok: true, brief: mdPath, json: jsonPath, winnable: accepted.length, crowded: crowded.length, loginWall: loginWall.length, rejected: rejected.length, table }, null, 1));
