/**
 * lib-mail.mjs — 线索来源：**你自己的职位提醒邮件**（2026-10-08 由 dsh 新建）
 *
 * 为什么走邮件而不是抓取：
 *   Upwork / Guru / Contra 等平台的条款禁止自动抓取与自动投标，账号封禁风险高。
 *   但这些平台会**主动把新职位提醒发到你的邮箱** —— 那是发给你的数据，读取自己的邮箱
 *   是被允许的，且完全不需要把平台密码交给任何程序。
 *
 * 本模块只做一件事：把提醒邮件解析成候选，剩下的交给 lib-gate.mjs 的可用性闸。
 *
 * 输入支持两种形态（都用同一解析器）：
 *   1) 导出的邮件文件目录：*.eml / *.txt / *.mbox（你手动导出，零配置、零凭据）
 *   2) 后续可接 IMAP（凭据只存在本机 env，绝不进仓库）
 */
import fs from 'node:fs';
import path from 'node:path';

/** 各平台职位链接的域名与路径特征（用于从邮件里认出真正的职位链接） */
const LINK_RULES = {
  upwork:   [/(?:^|\.)upwork\.com$/i, /\/jobs\//i],
  guru:     [/(?:^|\.)guru\.com$/i, /\/jobs\//i],
  contra:   [/(?:^|\.)contra\.com$/i, /\/opportunit|\/jobs/i],
  peopleperhour: [/(?:^|\.)peopleperhour\.com$/i, /\/job|\/freelance/i],
  freelancer:    [/(?:^|\.)freelancer\.com$/i, /\/projects\//i],
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

/** quoted-printable / base64 的粗略解码（够用于提醒邮件） */
function decodeBody(raw) {
  const qp = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return /^[A-Za-z0-9+/=\r\n]{200,}$/.test(raw.trim())
    ? Buffer.from(raw.replace(/\s/g, ''), 'base64').toString('utf8')
    : qp;
}

/** 从一封邮件文本里抽出职位候选 */
export function parseEmail(text, sourceId, src = {}) {
  const body = decodeBody(String(text || ''));
  const subjectMatch = body.match(/^Subject:\s*(.+)$/mi);
  const dateMatch = body.match(/^Date:\s*(.+)$/mi);
  const subject = subjectMatch ? decodeEntities(subjectMatch[1].trim()) : '';
  const dateRaw = dateMatch ? dateMatch[1].trim() : '';
  const posted = dateRaw && !isNaN(Date.parse(dateRaw)) ? new Date(dateRaw).toISOString() : null;

  const rule = LINK_RULES[sourceId] || [null, null];
  const found = new Map();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>|(https?:\/\/[^\s"'<>]+)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const url = decodeEntities(m[1] || m[3] || '').replace(/[).,;]+$/, '');
    const label = decodeEntities(String(m[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (!/^https?:\/\//i.test(url)) continue;
    let host, p;
    try { const u = new URL(url); host = u.hostname; p = u.pathname; } catch (e) { continue; }
    if (rule[0] && !rule[0].test(host)) continue;
    if (rule[1] && !rule[1].test(p)) continue;
    if (!found.has(url)) found.set(url, label);
  }

  // 没有 <a> 标签的纯文本邮件：退化到所有裸链接
  if (!found.size) {
    const bare = body.match(/https?:\/\/[^\s"'<>)]+/g) || [];
    for (const u0 of bare) {
      const u = u0.replace(/[).,;]+$/, '');
      let host, p;
      try { const x = new URL(u); host = x.hostname; p = x.pathname; } catch (e) { continue; }
      if (rule[0] && !rule[0].test(host)) continue;
      if (rule[1] && !rule[1].test(p)) continue;
      if (!found.has(u)) found.set(u, '');
    }
  }

  const out = [];
  for (const [url, label] of found) {
    out.push({
      source: sourceId,
      source_label: src.label || sourceId,
      title: (label || subject || url).slice(0, 140),
      url,
      summary: (label || subject || '').slice(0, 300),
      budget_min: 0, budget_max: 0, budget_usd_min: 0, budget_usd_max: 0, currency: 'USD',
      posted_ts: posted ? Math.floor(Date.parse(posted) / 1000) : null,
      posted_at: posted,
      bids: null,
      shape: 'contract',
      raw_status: 'mail-alert',
      matched_jobs: [],
    });
  }
  return { subject, posted, candidates: out };
}

/**
 * mailAlerts 适配器：读取 src.dir 下所有 *.eml / *.txt / *.mbox，解析出候选。
 * 目录不存在 → 返回空数组（并在调用方计数表里体现为 fetched=0），不报错、不编造。
 */
export async function mailAlerts(src, opts = {}) {
  const dir = src.dir || (src.dir_env ? process.env[src.dir_env] : '');
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /\.(eml|txt|mbox)$/i.test(f)).map((f) => path.join(dir, f));
  const seen = new Set();
  const out = [];
  for (const f of files) {
    let raw = '';
    try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    const docs = raw.includes('\nFrom ') && /\.mbox$/i.test(f) ? raw.split(/\nFrom /).map((x) => 'From ' + x) : [raw];
    for (const d of docs) {
      let parsed;
      try { parsed = parseEmail(d, src.id, src); } catch (e) { continue; }
      for (const c of parsed.candidates) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        out.push(c);
      }
    }
  }
  return out;
}

/** 供 --urls=<file> 模式使用：一行一个 URL，可用 "URL<TAB>标题" 附标题 */
export function loadUrlList(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [url, title] = t.split(/\t/);
    if (!/^https?:\/\//i.test(url)) continue;
    let host = '';
    try { host = new URL(url).hostname; } catch (e) { continue; }
    const sourceId = Object.keys(LINK_RULES).find((k) => LINK_RULES[k][0].test(host)) || 'manual';
    out.push({
      source: sourceId, source_label: '手动粘贴（' + host + '）',
      title: (title || url).slice(0, 140), url,
      summary: title || '', budget_min: 0, budget_max: 0, budget_usd_min: 0, budget_usd_max: 0,
      currency: 'USD', posted_ts: null, posted_at: null, bids: null,
      shape: 'contract', raw_status: 'manual-url', matched_jobs: [],
    });
  }
  return out;
}
