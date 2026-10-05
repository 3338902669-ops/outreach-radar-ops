export const meta = {
name: "lead-radar",
description: "获客雷达：定期扫描 15 个接单平台 48 小时内的新需求，去重、评分，输出中文商机简报与投标私信草稿",
phases: [
{ name: "scan", title: "扫描平台", description: "15 源并行扫描新需求，结果写入文件"},
{ name: "dedupe", title: "去重", description: "与历史推送记录比对，过滤已见过的"},
{ name: "score", title: "评分与话术", description: "商机打分并撰写投标私信草稿"},
{ name: "report", title: "简报", description: "生成用户可直接阅读的商机简报"}
]
};

const inputs = args?? {};
const baseDir = "workspace/goals/goal/hidden_files/radar";
const seenPath = baseDir + "/lead-seen.json";
const freshPath = baseDir + "/fresh.json";
const picksPath = baseDir + "/picks.json";
const digestPath = baseDir + "/digest.md";
const hoursBack = inputs.hoursBack || 48;
const maxLeads = inputs.maxLeads || 15;
const runLabel = inputs.runLabel || "本轮";

const SOURCES = [
{ key: "v2ex", label: "V2EX", brief: "在 V2EX（v2ex.com 的 jobs / freelance 相关节点）找外包或兼职需求，方向：网站开发、前端、爬虫、自动化脚本",
fields: "title（标题）、url（链接）、platform（固定填 V2EX）、budget（预算，没有就填未知）、posted（发布时间）、summary（一句话摘要）"},
{ key: "upwork", label: "Upwork", brief: "在 Upwork 上找 freelance job，方向：website development / website design / landing page / website redesign / wordpress / webflow / figma to html / web scraping",
fields: "title, url, platform（固定填 Upwork）, budget, posted, summary"},
{ key: "freelancer", label: "Freelancer", brief: "在 Freelancer.com（公开项目页）找项目需求，方向：website design / website development / landing page / wordpress",
fields: "title, url, platform（固定填 Freelancer）, budget, posted, summary"},
{ key: "dianya", label: "电鸭", brief: "在电鸭社区（eleduck.com 的招聘/远程工作板块）找远程兼职或外包需求，方向：网站开发、前端开发、Web 设计、小程序",
fields: "title（标题）、url（链接）、platform（固定填 电鸭）、budget（预算，没有就填未知）、posted（发布时间）、summary（一句话摘要）"},
{ key: "peopleperhour", label: "PeoplePerHour", brief: "在 PeoplePerHour（peopleperhour.com 的公开项目区）找项目需求，方向：website design / website development / landing page",
fields: "title, url, platform（固定填 PeoplePerHour）, budget, posted, summary"},
{ key: "guru", label: "Guru", brief: "在 Guru.com（公开工作区）找项目需求，方向：web development / web design / wordpress",
fields: "title, url, platform（固定填 Guru）, budget, posted, summary"},
{ key: "contra", label: "Contra", brief: "在 Contra（contra.com）找 freelance 项目需求，方向：website design / website development / landing page",
fields: "title, url, platform（固定填 Contra）, budget, posted, summary"},
{ key: "wwr", label: "WeWorkRemotely", brief: "在 We Work Remotely（weworkremotely.com 的 Programming / contract 板块）找远程工作或合同岗，方向：frontend / web development",
fields: "title, url, platform（固定填 WeWorkRemotely）, budget, posted, summary"},
{ key: "remoteok", label: "RemoteOK", brief: "在 RemoteOK（remoteok.com）找远程工作或合同岗，方向：frontend / web development",
fields: "title, url, platform（固定填 RemoteOK）, budget, posted, summary"},
{ key: "zb-oschina", label: "开源众包", brief: "在开源众包（zb.oschina.net 的悬赏项目区）找外包需求，方向：网站开发、前端、小程序",
fields: "title（标题）、url（链接）、platform（固定填 开源众包）、budget（预算，没有就填未知）、posted（发布时间）、summary（一句话摘要）"},
{ key: "proginn", label: "程序员客栈", brief: "在程序员客栈（proginn.com 的需求大厅/公开项目区）找外包需求，方向：网站开发、前端、小程序",
fields: "title（标题）、url（链接）、platform（固定填 程序员客栈）、budget（预算，没有就填未知）、posted（发布时间）、summary（一句话摘要）"},
{ key: "zbj", label: "猪八戒", brief: "在猪八戒（zbj.com 的需求大厅）找外包需求，方向：网站建设、网站设计、前端开发",
fields: "title（标题）、url（链接）、platform（固定填 猪八戒）、budget（预算，没有就填未知）、posted（发布时间）、summary（一句话摘要）"},
{ key: "fiverr", label: "Fiverr", brief: "在 Fiverr（fiverr.com）挖掘买家需求：通过搜索 buyer request / 需求帖及 Gig 反向推导，方向：website design / website development",
fields: "title, url, platform（固定填 Fiverr）, budget, posted, summary"},
{ key: "wellfound", label: "Wellfound", brief: "在 Wellfound（wellfound.com，原 AngelList Talent）找初创公司的合同/兼职岗，方向：frontend / web development",
fields: "title, url, platform（固定填 Wellfound）, budget, posted, summary"},
{ key: "catchall", label: "全网兜底", brief: "不限平台，在全网搜索近期发布的外包或兼职需求（Google 定向搜索，如 freelance website project / 网站外包 需求），方向：网站开发、前端、落地页、爬虫",
fields: "title（标题）、url（链接）、platform（填需求所在的实际平台名）、budget（预算，没有就填未知）、posted（发布时间）、summary（一句话摘要）"}
];
SOURCES.forEach(s => { s.file = baseDir + "/scan-" + s.key + ".json";});

phase("scan");
await parallel(SOURCES.map(s => () => agent(
"你是接单平台 scout。用网页搜索工具（不要用实时浏览器）" + s.brief + "，只找近 " + hoursBack + " 小时内发布的。" +
"只收录搜索结果中真实存在的需求，URL 必须是搜索返回的真实链接，严禁编造任何链接或需求。" +
"把结果写成 JSON 数组保存到文件 " + s.file + "（文件工具的相对路径从用户主目录解析；目录不存在就先创建）。" +
"每条记录字段：" + s.fields + "。" +
"找不到任何需求就写入空数组 []。写完文件后，只返回一行文字：DONE: N 条（N 为实际写入的条数）。",
{ key: "scan-" + s.key, label: "扫描" + s.label, timeoutMs: 180000}
)), { concurrency: 6});

phase("dedupe");
await agent(
"你是去重员。读取以下文件（JSON 数组；文件可能不存在，不存在就视为空数组；文件工具的相对路径从用户主目录解析）：" + SOURCES.map(s => s.file).join("、") + "，" +
"合并为全部 leads。再读取 " + seenPath + "（JSON 数组，存放已推送过的需求 URL；不存在视为空数组）。" +
"过滤掉 URL 已在历史数组中的条目；把新条目的 URL 追加进历史数组（只保留最近 500 条）并写回 " + seenPath + "；" +
"把去重后的新商机数组写入 " + freshPath + "（字段：title, url, platform, budget, posted, summary）。" +
"完成后只返回一行文字：DONE: M 条新商机（M 为去重后的条数）。",
{ key: "dedupe", label: "去重", timeoutMs: 120000}
);

phase("score");
await agent(
"你是资深自由职业顾问。我们团队能接：高端企业官网定制、落地页、品牌站动效（GSAP）、前端开发、爬虫、自动化脚本。" +
"读取文件 " + freshPath + "（JSON 数组；不存在或为空数组就直接跳过）。" +
"给每条按匹配度、预算吸引力、信息可信度打 1-5 分，综合排序后取前 " + maxLeads + " 条；" +
"为每条写一段 80 字以内的中文投标私信草稿（自我介绍 + 匹配点 + 交付承诺，不卑不亢，不提无法验证的资历）。" +
"把结果数组写入 " + picksPath + "（字段：title, url, platform, budget, score, reason, pitch）。" +
"fresh 为空时写入空数组。完成后只返回一行文字：DONE。",
{ key: "score", label: "评分与话术", timeoutMs: 180000}
);

phase("report");
const digestText = await agent(
"你是简报编辑。读取文件 " + picksPath + "（JSON 数组；不存在或为空就视为空数组）。" +
"生成一份中文商机简报（Markdown），标题为" + runLabel + "获客雷达简报。" +
"每条包含：平台、标题（附链接）、预算、评分（x/5）、一句话推荐理由、投标私信草稿（放在代码块中方便复制）。" +
"开头加一句总览（共发现 X 条新商机，覆盖 15 个来源）。picks 为空时，简报正文只写一句：本轮未发现新的匹配商机，雷达继续值守。" +
"把简报 Markdown 同时保存到文件 " + digestPath + "。" +
"然后把简报 Markdown 全文作为你的返回内容（只返回简报本身，不要加多余文字）。",
{ key: "report", label: "生成简报", timeoutMs: 120000}
);

return "\n\n" + digestText + "\n\n——\n投标和私信联系需要你用自己的平台账号操作，话术草稿可直接复制使用。雷达只负责发现和提醒，不会自动对外联系任何人。"
