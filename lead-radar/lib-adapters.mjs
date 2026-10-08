/**
 * lib-adapters.mjs — 各源适配器（2026-10-08 由 dsh 新建）
 * 原则：只实现**无需凭据、公开可抓**的源；需要登录/反爬的源在 sources.json 里标 reason，不假装能抓。
 * 每个适配器返回统一候选结构：
 * { source, source_label, title, url, summary, budget_min, budget_max, currency, posted_at(iso), posted_ts, bids, shape, raw_status }
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function getJson(url, opts = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json,*/*' }, signal: AbortSignal.timeout(opts.timeoutMs || 25000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}
async function getText(url, opts = {}) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: AbortSignal.timeout(opts.timeoutMs || 25000) });
  return { status: res.status, url: res.url, text: await res.text() };
}

/**
 * 只保留与我们强项**真正吻合**的技能（按 job name 精确匹配）。
 * 2026-10-08 实测教训：先前用宽泛的 /design|site/ 正则，把 PCB 电路设计、教学设计师、
 * 印地语歌词配唱都收进来了并给了 7/10 —— 那是指标污染，不是"覆盖广"。
 */
const WEB_JOBS = /^(web development|website design|web design|website|html|html5|css|css3|javascript|react\.?js|vue\.?js|wordpress|woocommerce|shopify|webflow|elementor|wix|squarespace|landing page|front[- ]?end development|front[- ]?end|php|web scraping|data scraping|automation|figma|ui\/ux|ui design|ux design|graphic design|responsive design|website optimization|seo)$/i;
const NOT_WEB = /(instructional|circuit|pcb|electronic|sound|music|audio|voice|singing|lyric|video|animation|3d|translat|writing|article|copy ?writ|data entry|excel|accounting|logo|illustration|photograph)/i;
function isWebJob(name) { const n = String(name || '').trim(); return WEB_JOBS.test(n) && !NOT_WEB.test(n); }

export async function freelancer(src, opts = {}) {
  const out = [];
  const limit = opts.limit || 100;
  // 2026-10-08：原先只抓第 1 页（50 条里筛出 7 条）。改为分页抓取 + 服务端按技能过滤，成倍提高有效候选。
  const pages = opts.pages || 3;
  const JOB_IDS = [9, 3, 40, 17, 994, 984, 200, 551, 922, 993, 30, 202, 42, 31, 5]; // Web Dev/Web Design/HTML/CSS/JS/Scraping/Automation/React/WP/Webflow/Landing/PHP/Figma
  const projects = [];
  for (let p = 0; p < pages; p++) {
    const url = 'https://www.freelancer.com/api/projects/0.1/projects/active/?limit=' + limit +
      '&offset=' + (p * limit) + '&job_details=true&full_description=true&upgrade_details=true&user_details=true&compact=true&sort_field=time_updated' +
      '&jobs[]=' + JOB_IDS.join('&jobs[]=');
    let j;
    try { j = await getJson(url); } catch (e) { break; }
    const batch = (j.result && j.result.projects) || [];
    if (!batch.length) break;
    projects.push(...batch);
    if (batch.length < limit) break;
  }
  for (const p of projects) {
    const hit = (p.jobs || []).filter((x) => isWebJob(x.name));
    if (!hit.length) continue;
    // 2026-10-08 二次收紧：技能标签里只要沾一个 PHP 就会把「教学设计师」放进来。
    // 因此还要求标题/摘要本身含 web 语义词。
    const blob = String(p.title || '') + ' ' + String(p.preview_description || p.description || '');
    if (!/(website|web site|web\b|wordpress|woocommerce|shopify|webflow|landing page|front[- ]?end|html|css|javascript|react|vue|figma|ui\b|ux\b|seo|elementor|wix|squarespace|scrap|crawl|automat|responsive|bootstrap|tailwind)/i.test(blob)) continue;
    const b = p.budget || {};
    out.push({
      source: 'freelancer', source_label: 'Freelancer.com',
      title: p.title,
      url: 'https://www.freelancer.com/projects/' + (p.seo_url || String(p.id)),
      summary: (p.preview_description || p.description || '').slice(0, 400),
      budget_min: b.minimum || 0, budget_max: b.maximum || 0,
      currency: (p.currency && p.currency.code) || 'USD',
      budget_usd_min: toUsd(b.minimum, (p.currency && p.currency.code) || 'USD'),
      budget_usd_max: toUsd(b.maximum, (p.currency && p.currency.code) || 'USD'),
      posted_ts: p.time_submitted || null,
      posted_at: p.time_submitted ? new Date(p.time_submitted * 1000).toISOString() : null,
      bids: (p.bid_stats && p.bid_stats.bid_count) || 0,
      shape: 'contract',
      raw_status: p.status + '/' + (p.sub_status || '-') + ' type=' + p.type,
      matched_jobs: hit.map((x) => x.name).slice(0, 6),
    });
  }
  return out;
}

const V2EX_WEB = /(前端|网站|网页|小程序|H5|React|Vue|WordPress|全栈|开发|爬虫|自动化|Web|web)/;
const V2EX_NOT = /(嵌入式|固件|蓝牙|硬件|芯片|单片机|算法工程师|音视频|游戏开发|运维|测试工程师|数据科学)/;

export async function v2ex(src, opts = {}) {
  const j = await getJson('https://www.v2ex.com/api/topics/show.json?node_name=jobs');
  const out = [];
  for (const t of Array.isArray(j) ? j : []) {
    const text = (t.title || '') + ' ' + (t.content || '');
    // 2026-10-08：V2EX 的 jobs 节点混着讨论帖、嵌入式岗、SEO 岗 —— 只要与前端/网站/自动化无关就不收
    if (!V2EX_WEB.test(text) || V2EX_NOT.test(text)) continue;
    out.push({
      source: 'v2ex', source_label: 'V2EX',
      title: t.title,
      url: t.url || ('https://www.v2ex.com/t/' + t.id),
      summary: (t.content || '').replace(/\s+/g, ' ').slice(0, 400),
      budget_min: 0, budget_max: 0, currency: 'CNY',
      posted_ts: t.created || null,
      posted_at: t.created ? new Date(t.created * 1000).toISOString() : null,
      bids: t.replies || 0,
      // 只保留外包/接单语义；招聘/求职帖直接判 fulltime 进附录，不混进正文
      shape: /(招聘|全职|求职|简历|招人)/.test(text) && !/(外包|接单|众包|兼职)/.test(text)
        ? 'fulltime'
        : /(外包|接单|众包|私活|按项目结算|项目制)/.test(text) ? 'contract' : 'unknown',
      raw_status: 'topic',
      matched_jobs: [],
    });
  }
  return out;
}

export async function eleduck(src, opts = {}) {
  const r = await getText('https://eleduck.com/categories/5');
  const out = [];
  const m = r.text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return out; // 结构不可解析 → 如实返回 0 条，不编造
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return out; }
  const posts = (data && data.props && data.props.pageProps && (data.props.pageProps.posts || data.props.pageProps.data)) || [];
  for (const p of Array.isArray(posts) ? posts : []) {
    if (!p || !p.title) continue;
    out.push({
      source: 'eleduck', source_label: '电鸭社区',
      title: p.title,
      url: 'https://eleduck.com/posts/' + (p.id || ''),
      summary: String(p.summary || p.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400),
      budget_min: 0, budget_max: 0, currency: 'CNY',
      posted_ts: p.published_at ? Math.floor(new Date(p.published_at).getTime() / 1000) : null,
      posted_at: p.published_at || null,
      bids: p.comments_count || 0,
      shape: 'contract',
      raw_status: 'post',
      matched_jobs: [],
    });
  }
  return out;
}

export async function remoteok(src, opts = {}) {
  const j = await getJson('https://remoteok.com/api');
  const out = [];
  for (const p of (Array.isArray(j) ? j : []).slice(1)) {
    if (!p || !p.position) continue;
    out.push({
      source: 'remoteok', source_label: 'RemoteOK',
      title: p.position + ' @ ' + (p.company || ''),
      url: p.url || p.apply_url || '',
      summary: String(p.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300),
      budget_min: 0, budget_max: 0, currency: 'USD',
      posted_ts: p.epoch ? Number(p.epoch) : null,
      posted_at: p.date || null,
      bids: 0, shape: 'fulltime', raw_status: 'job', matched_jobs: [],
    });
  }
  return out;
}

/** 粗略汇率（2026-10 量级），仅用于**跨币种可比**的评分；不用于报价 */
export const FX_TO_USD = { USD: 1, EUR: 1.08, GBP: 1.27, INR: 0.012, CNY: 0.14, AUD: 0.66, CAD: 0.73, SGD: 0.74, JPY: 0.0067 };
export function toUsd(amount, currency) {
  const r = FX_TO_USD[String(currency || 'USD').toUpperCase()] || 1;
  return Math.round(Number(amount || 0) * r * 100) / 100;
}

export const ADAPTERS = { freelancer, v2ex, eleduck, remoteok };
