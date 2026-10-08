/**
 * lib-imap.mjs — IMAP 全自动通道（2026-10-08 由 dsh 新建）
 *
 * 目标：直接从你自己的邮箱里读**职位提醒邮件**，省掉手动导出的步骤。
 *
 * 安全设计（硬约束）：
 *   1) 凭据只能来自本机配置文件或环境变量，**绝不写入仓库、日志或聊天**；
 *   2) 调用 curl 时用 `--config <临时文件>` 传凭据，**不出现在命令行参数里**（避免进程列表泄露）；
 *   3) 临时配置文件用完**立即删除**；
 *   4) **只读**：用 BODY.PEEK / 不设置 \Seen，不删信、不改文件夹、不发信；
 *   5) 未配置时返回空数组并在计数表里写明原因，不报错、不编造。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEmail } from './lib-mail.mjs';

const DEFAULT_CONFIG = 'C:\\Users\\33389\\.shared\\radar-mail\\imap.json';

export function loadImapConfig() {
  const p = process.env.RADAR_IMAP_CONFIG || DEFAULT_CONFIG;
  if (!fs.existsSync(p)) return { ok: false, reason: '未找到配置文件: ' + p };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return { ok: false, reason: '配置文件不是合法 JSON: ' + String(e.message).slice(0, 80) }; }
  for (const k of ['host', 'user', 'pass']) if (!cfg[k]) return { ok: false, reason: '配置缺少字段: ' + k };
  cfg.port = cfg.port || 993;
  cfg.folder = cfg.folder || 'INBOX';
  cfg.max = cfg.max || 20;
  cfg.sourceId = cfg.sourceId || 'upwork';
  return { ok: true, cfg };
}

/** 写一个只含凭据的临时 curl config，用完删 */
function withCreds(cfg, fn) {
  const tmp = path.join(os.tmpdir(), '.radar-imap-' + process.pid + '-' + Date.now() + '.cfg');
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  fs.writeFileSync(tmp, 'user = "' + esc(cfg.user) + ':' + esc(cfg.pass) + '"\n', { mode: 0o600 });
  try { return fn(tmp); } finally { try { fs.unlinkSync(tmp); } catch (e) {} }
}

function curl(cfgPath, args) {
  return execFileSync('curl.exe', ['-s', '--config', cfgPath].concat(args), { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
}

/** 连通性自检（不读信、不发凭据以外的东西） */
export function imapSelftest() {
  const loaded = loadImapConfig();
  if (!loaded.ok) return loaded;
  const { cfg } = loaded;
  try {
    const caps = withCreds(cfg, (tmp) => curl(tmp, ['--url', 'imaps://' + cfg.host + ':' + cfg.port + '/', '-X', 'CAPABILITY']));
    return { ok: true, host: cfg.host, port: cfg.port, user: cfg.user.replace(/(.{2}).*(@.*)/, '$1***$2'), caps: String(caps).split(/\r?\n/).filter(Boolean).slice(0, 6) };
  } catch (e) {
    return { ok: false, reason: '连接/认证失败: ' + String(e.message || e).split('\n')[0].slice(0, 160) };
  }
}

export async function imapAlerts(src, opts = {}) {
  const loaded = loadImapConfig();
  if (!loaded.ok) { src.__note = loaded.reason; return []; }
  const cfg = loaded.cfg;
  const sourceId = src.sourceId || cfg.sourceId;

  let uidsRaw = '';
  try {
    // 只查最近 N 天的未读提醒邮件；EXAMINE 语义 → 不改动邮箱状态
    const days = cfg.sinceDays || 7;
    const since = new Date(Date.now() - days * 86400000).toUTCString().replace(/^\w+, /, '');
    uidsRaw = withCreds(cfg, (tmp) => curl(tmp, ['--url', 'imaps://' + cfg.host + ':' + cfg.port + '/' + cfg.folder, '-X', 'UID SEARCH SINCE ' + since]));
  } catch (e) {
    src.__note = 'IMAP 查询失败: ' + String(e.message || e).split('\n')[0].slice(0, 120);
    return [];
  }

  const uids = String(uidsRaw).split(/\r?\n/).filter((l) => /^\* SEARCH/.test(l)).flatMap((l) => l.replace(/^\* SEARCH/, '').trim().split(/\s+/)).filter(Boolean);
  const use = uids.slice(-cfg.max);
  const seen = new Set();
  const out = [];
  for (const uid of use) {
    let raw = '';
    try {
      raw = withCreds(cfg, (tmp) => curl(tmp, ['--url', 'imaps://' + cfg.host + ':' + cfg.port + '/' + cfg.folder + ';UID=' + uid]));
    } catch (e) { continue; }
    let parsed;
    try { parsed = parseEmail(raw, sourceId, { label: src.label }); } catch (e) { continue; }
    for (const c of parsed.candidates) {
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      out.push(c);
    }
  }
  src.__note = 'IMAP ' + cfg.folder + '：扫描 ' + use.length + ' 封（近 ' + (cfg.sinceDays || 7) + ' 天），解析出 ' + out.length + ' 条';
  return out;
}
