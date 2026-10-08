/**
 * gate.mjs — 可用性闸（MB-005/0009 要求的核心缺失件，2026-10-08 由 dsh 实现）
 * 任何候选在进入简报前必须过此闸；不过的只能进附录，理由必须写明。
 * 零依赖，Node 18+。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CLOSED_RE = /\b(closed|expired|awarded|filled|cancelled|canceled|no longer accepting|project closed)\b/i;
const CN_CLOSED_RE = /(已关闭|已结束|已截止|已成交|停止招募|不再接受)/;

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 形态判定：接单/项目制 vs 全职招聘 */
export function classifyShape(text) {
  const t = String(text || '');
  const fulltime = /(full[- ]?time|permanent|full time employee|全职|正式员工)/i.test(t);
  const contract = /(contract|freelance|fixed[- ]?price|project|gig|外包|兼职|按项目|众包)/i.test(t);
  if (fulltime && !contract) return 'fulltime';
  if (contract) return 'contract';
  return 'unknown';
}

/**
 * 对一个候选 URL 跑闸。
 * @returns {{ok:boolean, shape:string, http_status:number|null, final_url:string, title:string|null, posted_at:string|null, problems:string[], checked_at:string}}
 */
export async function runGate(url, opts = {}) {
  const checked_at = new Date().toISOString();
  const problems = [];
  let http_status = null, final_url = url, title = null, body = '';
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept': 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(opts.timeoutMs || 20000),
    });
    http_status = res.status;
    final_url = res.url || url;
    body = await res.text();
  } catch (e) {
    problems.push('请求失败: ' + String(e.message || e).slice(0, 120));
    return { ok: false, shape: 'unknown', http_status, final_url, title, posted_at: null, problems, checked_at };
  }

  if (http_status === 404) problems.push('HTTP 404（死链）');
  else if (http_status >= 400) problems.push('HTTP ' + http_status);
  if (!/^https?:\/\//.test(final_url)) problems.push('最终 URL 非法');

  const text = stripTags(body);
  const m = body.match(/<title[^>]*>([^<]{0,200})<\/title>/i);
  title = m ? m[1].trim() : null;

  if (CLOSED_RE.test(text) || CN_CLOSED_RE.test(text)) problems.push('正文含关闭/过期标记（closed/expired/awarded…）');
  if (text.length < 200) problems.push('正文过短（' + text.length + ' 字符），可能是兜底页或需登录');

  const shape = classifyShape(text);
  if (shape === 'fulltime') problems.push('形态为全职招聘，非项目制外包');
  else if (shape === 'unknown') problems.push('形态无法判定（未见 contract/fulltime 关键词）');

  const pm = text.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/) || text.match(/(\d{1,2}\s+(?:hours?|days?|minutes?)\s+ago)/i);
  const posted_at = pm ? pm[1] : null;

  return { ok: problems.length === 0, shape, http_status, final_url, title, posted_at, problems, checked_at };
}

export function scoreLead(lead) {
  const reasons = [];
  let score = 0;
  const t = (lead.title || '') + ' ' + (lead.summary || '');
  if (/(website|web ?site|web|frontend|front[- ]end|landing page|wordpress|webflow|figma|html|css|javascript|react|design)/i.test(t)) { score += 3; reasons.push('技能匹配 +3'); }
  if (/(scrap|crawl|automat|script|parser|data extraction)/i.test(t)) { score += 2; reasons.push('爬虫/自动化匹配 +2'); }
  // 2026-10-08 修复：预算一律换算成 USD 再分档 —— 否则 INR 12500 会被当成 12500 美元给满分
  // 用区间中点分档：250-750 的"上限 750"不该按 ≥750 记分
  const b = lead.budget_usd_min != null && lead.budget_usd_max != null
    ? (Number(lead.budget_usd_min) + Number(lead.budget_usd_max)) / 2
    : Number(lead.budget_usd_max || lead.budget_max || 0);
  if (b >= 2000) { score += 3; reasons.push('预算 ≥$2000 +3'); }
  else if (b >= 750) { score += 2; reasons.push('预算 ≥$750 +2'); }
  else if (b >= 250) { score += 1; reasons.push('预算 ≥$250 +1'); }
  else if (b > 0) { reasons.push('预算 <$250 +0'); }
  if (lead.posted_at) { score += 1; reasons.push('有发布时间 +1'); }
  const bids = Number(lead.bids || 0);
  if (lead.bids != null && bids <= 5) { score += 1; reasons.push('投标数 ≤5 +1'); }
  else if (bids > 50) { score -= 2; reasons.push('投标数 >50 −2（几无胜算）'); }
  else if (bids > 20) { score -= 1; reasons.push('投标数 >20 −1'); }
  return { score: Math.max(0, Math.min(score, 10)), max: 10, reasons };
}
