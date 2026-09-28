# Invariants Suite — 一个脚本，一条判决

> 不变量套件解决的问题是：**"系统现在到底好不好？"** —— 而不是"我要翻几个日志文件才能看出来"。

---

## 1. 为什么不用一堆分散的检查

分散检查有三个必然结局：**没人全部跑 · 跑了没人汇总 · 汇总了不是机器可读的**。

不变量套件把它压成：**一次运行 + 一行 JSON + 一个退出码**。

---

## 2. 骨架

```js
#!/usr/bin/env node
// invariants.cjs — 一次运行，一条判决
'use strict';
const fs = require('fs');
const checks = [];
const add = (id, ok, detail, offenders) => checks.push({
  id: id, ok: !!ok, detail: detail,
  offenders: (offenders || []).slice(0, 8), n: (offenders || []).length
});

// ---- 每条不变量：一个块，一个 id，一句人话 detail ----
{ // R1 时区必须是合法 IANA 名称
  const re = new RegExp('^[A-Za-z]+(/[A-Za-z_+0-9-]+)+$');
  const bad = letters.filter((l) => !re.test(String(l.timezone)))
                     .map((l) => l.email + ' (' + l.timezone + ')');
  add('R1 timezone', bad.length === 0, bad.length + ' letters without a valid IANA timezone', bad);
}

{ // R2 每封信有同尺子评分且达标
  const bad = letters.filter((l) => typeof l.score !== 'number' || l.score < 75)
                     .map((l) => l.email + ' score=' + l.score);
  add('R2 score>=75', bad.length === 0, bad.length + ' letters without a qualifying score', bad);
}

{ // R5 同一收件人 7 天内不重复触达
  const by = new Map();
  for (const l of letters) {
    const k = String(l.email).toLowerCase();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(Date.parse(l.sendAt));
  }
  const bad = [];
  for (const entry of by) {
    const stamps = entry[1].filter((x) => !isNaN(x)).sort((a, b) => a - b);
    for (let i = 1; i < stamps.length; i++) {
      const gap = (stamps[i] - stamps[i - 1]) / 864e5;
      if (gap < 7) bad.push(entry[0] + ' gap ' + gap.toFixed(1) + 'd');
    }
  }
  add('R5 spacing>=7d', bad.length === 0, bad.length + ' recipients touched twice inside 7 days', bad);
}

// ---- 判决 ----
const failed = checks.filter((c) => !c.ok);
const out = {
  at: new Date().toISOString(), suite: 'invariants',
  checks: checks.length, passed: checks.length - failed.length, failed: failed.length,
  verdict: failed.length ? 'FAIL' : 'PASS', detail: failed
};

for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.id.padEnd(28) + ' ' + c.detail);
console.log('--- ' + checks.length + ' checks, ' + failed.length + ' failed ---');
console.log(JSON.stringify(out));          // <= 必须是最后一行
process.exit(failed.length ? 1 : 0);
```

---

## 3. 五条设计要点（照抄）

| # | 要点 | 为什么 |
|---|---|---|
| 1 | **最后一行永远是机器可读 JSON** | 调用方解析它。曾有版本只输出人看的行，调用方把它读成"没运行" |
| 2 | **退出码 = 判决** | 有 FAIL 就非零，可直接接进流水线 |
| 3 | **每条规则注明它来自哪次事故** | 没有事故出处的规则会越积越多、越改越滥 |
| 4 | **历史遗留数据用 warning，不用 FAIL** | 不要为了让数字好看去重写已批准的历史记录 |
| 5 | **谓词与生成器共用同一份实现** | 否则"回填脚本"会把刚被拒绝的东西塞回队列 |

### 第 5 条的实测教训

> 曾经把"版式判定"的逻辑在**两个文件里各写一遍**：一个用于不变量检查，一个用于"回填/修复"脚本。
> 结果：回填脚本把不变量刚刚**拒绝**的一封信重新排回了队列 —— 因为它只检查了"归一化是否跑过"，没检查"归一化之后是否符合版式"。
>
> **修法：把谓词抽成独立模块，两边都 require 它。判定逻辑只允许存在一份。**

---

## 4. 事故 → 规则：把出处写在文件开头

```js
// incident -> rule map:
//   2026-xx-xx 内部备注泄漏进正文            -> R7 language
//   2026-xx-xx 信件引用了线上不存在的文案     -> R8 claim gate
//   2026-xx-xx 报告页改版导致链接失效         -> R9 report links resolve
//   2026-xx-xx 声明域名与正文链接域名不一致   -> R4 domain must match body link
//   2026-xx-xx 时区写成 UTC，本地窗口失效     -> R1 valid IANA timezone
//   2026-xx-xx 一批队列信没有评分           -> R2 score >= 75
//   2026-xx-xx 同一收件人收到重复信           -> R3/R5 duplicate + spacing
//   2026-xx-xx 陈旧锁阻塞了后续所有运行       -> R13 mutex hygiene
```

**这张表本身就是资产。** 半年后接手的人（或 agent）看完它，就知道每道闸门在防什么，以及**删掉它会重新发生什么**。

---

## 5. 纳入值守

不变量套件应当被**值班体检脚本**调用，并把结果写进值守日志：

```js
// operator-check.cjs 片段
const r = run('node', ['invariants.cjs', '--json=verdict.json']);
const lines = r.stdout.trim().split(/\r?\n/);
const verdict = JSON.parse(lines[lines.length - 1]);   // 只认最后一行
operatorLog.push({
  at: new Date().toISOString(), suite: verdict.suite,
  verdict: verdict.verdict, failed: verdict.failed, detail: verdict.detail
});
```

> **解析一定要取最后一行**，不要用正则去抓给人看的那些行 —— 人类可读的格式会改，机器可读的那行不会。
