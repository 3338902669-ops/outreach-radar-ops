# Gate Design — 怎么写一道 fail-closed 的闸门

> 闸门是本套系统里唯一有权说"不许发"的组件。它写错了，整套系统就是一台高速群发器。

---

## 1. 三条设计原则

**① fail-closed（默认拒绝）**

拿不准 → 拒绝。异常 → 拒绝。读不到数据 → 拒绝。绝不允许"检查失败所以放行"的分支。

```js
// 反例：读不到抑制名单就继续发 —— 最危险的写法
let suppressed = [];
try { suppressed = readSuppress(); } catch (e) { /* 空数组，继续 */ }

// 正例：读不到 = 无法证明它可以发 = 拒绝
let suppressed;
try { suppressed = readSuppress(); }
catch (e) { fail('suppress-unreadable', e.message); }   // 退出码 2，不产出队列
```

**② 一次运行，一条判决**

闸门不是一个"检查函数集合"，是一个可执行文件：读一个队列文件，输出一个判决。

```
$ node gate.cjs letters-20260101-auto1-scheduled.json
{"gate":"<name>","checked":42,"passed":40,"failed":2,"verdict":"FAIL","detail":[...]}
$ echo $?
1
```

**③ 退出码语义四分离**

| 退出码 | 含义 | 调用方该做什么 |
|---|---|---|
| 0 | 通过 | 入队 |
| 1 | **有真实发现**（问题是真的） | 修复内容后重跑；**绝不重试同一输入** |
| 2 | 受阻、无结论 | 修通道/依赖后重跑；**不得当成通过** |
| 3 | 预检失败（根本没跑） | 修预检；**不得当成通过** |

> **反模式**：把 2 和 3 混进 0。这是"静默放行"的主要来源。

---

## 2. 闸门骨架（可直接改）

```js
#!/usr/bin/env node
// gate.cjs — <用途>；fail-closed
'use strict';
const fs = require('fs'), path = require('path');

const RC = { PASS: 0, FINDINGS: 1, BLOCKED: 2, PREFLIGHT: 3 };
const die = (code, reason, extra) => {
  console.log(JSON.stringify(Object.assign({ gate: '<name>', reason: reason, verdict: 'ERROR' }, extra || {})));
  process.exit(code);
};

const file = process.argv[2];
if (!file) die(RC.PREFLIGHT, 'no-queue-file');
if (!fs.existsSync(file)) die(RC.PREFLIGHT, 'queue-file-missing', { file: file });

// --- 预检：依赖的账本必须全部可读，否则是"没有结论"而不是"通过" ---
const readJson = (p) => {
  let s;
  try { s = fs.readFileSync(p, 'utf8'); }
  catch (e) { die(RC.BLOCKED, 'ledger-unreadable', { ledger: path.basename(p) }); }
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);      // BOM 必须剥，否则 parse 抛
  try { return JSON.parse(s); }
  catch (e) { die(RC.BLOCKED, 'ledger-malformed', { ledger: path.basename(p) }); }
};

const sent = readJson(path.join(ROOT, 'sent-ledger.json'));
const suppress = readJson(path.join(ROOT, 'suppress.json'));
const letters = readJson(file);
const arr = Array.isArray(letters) ? letters : (letters.letters || []);
if (!arr.length) die(RC.PREFLIGHT, 'empty-batch');

// --- 规则：每条独立记名，便于不变量套件引用 ---
const problems = [];
const RULES = {
  suppressed: (l, s) => s.has(String(l.email).toLowerCase()) ? 'in-suppress-list' : null,
  alreadySent: (l, s) => s.has(String(l.email).toLowerCase()) ? 'already-contacted' : null,
  score: (l) => (typeof l.score === 'number' && l.score >= 75) ? null : 'score-below-threshold'
};

for (const l of arr) {
  for (const name of Object.keys(RULES)) {
    const why = RULES[name](l, suppress);
    if (why) problems.push({ rule: name, email: l.email, why: why });
  }
}

const bad = new Set(problems.map((p) => p.email));
const out = {
  gate: '<name>', checked: arr.length, passed: arr.length - bad.size, failed: bad.size,
  verdict: problems.length ? 'FAIL' : 'PASS', detail: problems
};
console.log(JSON.stringify(out));
process.exit(problems.length ? RC.FINDINGS : RC.PASS);
```

---

## 3. 双闸门：为什么不能合并

首封与跟进的**语义前提是相反的**，合并必然错。

| | 首封闸 | 跟进闸 |
|---|---|---|
| "此人已联系过" | **拦截** | **正常** |
| 关键问题 | 该不该第一次联系他 | 该不该**再**联系他 |
| 必查 | 体量豁免 / 评分 / 邮箱有效性 | 抑制 / 最小间隔 / 频次上限 / 前置产出 |

> **实践判据**：如果一道闸让**整批**失败，几乎一定是**闸选错了**，不是数据全脏了。先换闸重跑，再查数据。

---

## 4. 内容闸：把"信里说的话"变成可核验断言

最值钱的一道闸。它的输入不是"信写得好不好"，而是**信里的每条具体断言能否在来源页面上找到**。

```js
// 宣称闸核心：抽取 → 比对 → 记账 → 可恢复
const claims = extractClaims(letter.body);        // 主语 + 断言 + 被引用的文案片段
for (const c of claims) {
  const found = await siteContains(letter.domain, c.quotedText);   // 一手来源，不查搜索缓存
  if (!found) {
    ledger[letter.email] = { reason: c.why, at: new Date().toISOString(), status: 'blocked' };
    problems.push({ email: letter.email, claim: c.quotedText, why: 'claim-not-on-live-site' });
  }
}
```

**三条配套规则：**

1. **拦截要记账**：原因 + 时间戳 + status。没有台账，拦截就是丢失。
2. **重写后可恢复**：重写 → 再过闸 → 通过则 status 改 resolved-verified，信回队列。
3. **只有未解决才算违规**：不变量检查时，已解决条目**不计入**。否则你修好了它，它却还在报错。

---

## 5. 闸门自检（先证明它会失败）

新闸门上线前，**必须用故意做坏的样本证明它会红**：

```js
// test-gate.cjs —— 每条规则至少一个"应当失败"的夹具
const cases = [
  { name: 'suppressed recipient is blocked', letter: { email: 'a@example.com' }, expect: 'in-suppress-list' },
  { name: 'low score is blocked',            letter: { email: 'b@example.com', score: 10 }, expect: 'score-below-threshold' },
  { name: 'clean letter passes',             letter: { email: 'c@example.com', score: 80 }, expect: null }
];
```

> **一个从来没红过的闸门，等于一盏坏掉的灯。**
> 判定"闸门有效"的证据不是"它跑通了"，而是"它拦住了一个应该被拦的东西"。
