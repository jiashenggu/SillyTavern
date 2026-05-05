# SillyTavern 文字竖排问题 —— 最终诊断与修复记录

> 初版:2026-04-19(基于半诊断的临时方案)
> 重写 v2:2026-04-19(根因定位完成,模板已修)
> 重写 v3:2026-04-19(**真·根因是 AI 自创 HTML,最终方案是 Custom CSS 兜底**)
> 重写 v4:2026-04-19(**第二类根因——流式 partial state。Custom CSS 对流式态无效,需禁用 regex 00a**)
> 状态:⚠️ **分层已解决**——完成态由 Custom CSS 兜底(v3),流式态由禁用 00a 解决(v4)

---

## TL;DR(三层递进)

1. **初步判断**:潮汐预设模板的 HTML 在窄容器下 `flex-direction: column` 让字逐个竖排
2. **修一半**:改了 8 处 `replaceString` 加 `min-width: 160px; white-space: nowrap;` —— 对**走正则管道的 `battle-title`** 有效(Console 验证 `min-width: 160px | white-space: nowrap | width: 160px`)
3. **发现真相**:真正竖排的是 **`details.custom-battle-review`**(带 `custom-` 前缀),仓库里零定义 = **AI 自己编的 class**,压根不经过正则
4. **最终方案**:**Custom CSS 加通用属性选择器兜底**,捕获所有 AI 自创"类似潮汐折叠框"的 HTML

---

## 一、根因全貌

### 三个独立的问题叠加

| 层 | 问题 | 结果 |
|---|---|---|
| L1 · 预设模板 | `battle-title` 用 `flex-direction: column` 无 `min-width` | 窄容器下压扁逐字竖排 |
| L2 · AI 模仿自创 | 编出 `custom-battle-review` / `custom-battle-title` 等**非注册**的 class,直接把 HTML 输出到正文 | **不走正则管道**,完全绕过正则转换链 |
| L3 · 主题变量缺失 | 双色盒子主题没定义模板期望的 `--font-main`, `--text-primary`, `--tide-*` 五个变量 | 字体 fallback 到 Zen Maru Gothic、颜色 fallback 到 `#2c3e50` |

L1 修了 replaceString → 只解决"AI 按 prompt 正确写 `<!-- 工头潮汐 -->` 然后正则转 HTML"这条路径。
L2 是真核心 —— **AI 把在训练数据里见过的各种"折叠框 HTML 片段"乱拼,随手加 `custom-` 前缀当 class**。这种 HTML 直接进入消息内容,不被正则匹配,模板改了也不影响。
L3 是视觉问题(字体/颜色不对),不是布局问题(不会造成竖排)。

### fallback 跟竖排是两件事(别混淆)

| 属性 | 性质 | 会造成竖排? |
|---|---|---|
| `flex-direction: column` + 窄容器 + CJK 默认逐字可断 | 布局 | ✅ 真凶 |
| `font-family` fallback → Zen Maru Gothic | 视觉 | ❌ 只是指纹,说明变量未定义 |
| `color` fallback → `#2c3e50` | 视觉 | ❌ 同上 |

---

## 二、已执行的修复(层层推进)

### 修复 1(已做):预设模板 `replaceString` 改 8 处

文件:
- `data/default-user/OpenAI Settings/潮汐Chaoxi   改 (1).json`(预设文件,4 处)
- `data/default-user/settings.json`(运行时工作副本,4 处)

改动:在 `class="battle-title"` span 的 inline style 里追加:
```diff
  padding: 4px 12px;
  border-radius: 20px;
+ min-width: 160px;
+ white-space: nowrap;
```

**效果**:对 AI 按格式写 `<!-- 工头潮汐 -->` 注释 → 正则转 `battle-title` 折叠框的路径**有效**。
**局限**:对 AI 自由发挥写的 `custom-battle-review` / 其他变种 HTML **无效**。

### 修复 2(已做):双色盒子主题补 5 个 CSS 变量

文件:`data/default-user/themes/双色盒子-深色.json` 的 `custom_css` 字段末尾追加:

```css
/* === 补：潮汐预设模板期望的 CSS 变量 fallback === */
:root {
  --font-main: var(--mainFontFamily);
  --text-primary: var(--SmartThemeBodyColor);
  --tide-deep: #2c4a6e;
  --tide-light: #a8d4e6;
  --tide-medium: #5b8fb9;
}
```

**效果**:解决 L3 层字体/颜色 fallback(视觉问题)。
**与竖排无关**(前面已澄清)。

### 修复 3(最终方案,已做):Custom CSS 通用兜底

**文件**:User Settings → Custom CSS(不写进主题,方便切换时不丢失)

**CSS**:

```css
/* === 潮汐折叠框 + AI 自创模板统一兜底 === */

/* 1. 折叠框容器和内部块(battle/review 相关)保持最小可读宽度 */
.battle-review,
.battle-title,
.custom-battle-title,
details[class*="battle"],
details[class*="review"] {
  min-width: 280px !important;
  max-width: 100% !important;
}

/* 2. summary 兜底:AI 可能把 summary 设成 flex column 压扁子元素 */
details[class*="battle"] > summary,
details[class*="review"] > summary {
  min-width: 300px !important;
  max-width: 100% !important;
  flex-wrap: wrap !important;
}

/* 3. 折叠框内的 p / span 按词断行,不逐字 */
details[class*="battle"] summary p,
details[class*="battle"] summary span,
details[class*="review"] summary p,
details[class*="review"] summary span,
[class*="custom-battle"] p,
[class*="custom-battle"] span,
.battle-review > div {
  min-width: 200px !important;
  max-width: 100% !important;
  word-break: keep-all !important;
  overflow-wrap: break-word !important;
  white-space: normal !important;
}

/* 4. 自身也不允许逐字断,防止 class 本身就带 overflow-wrap: anywhere 的模板 */
[class*="battle"],
[class*="review"] {
  overflow-wrap: break-word !important;
  word-break: keep-all !important;
}

/* 5. JS-Slash-Runner iframe 兜底(即使现在 iframe 是 0×0 也先放着) */
.mes_text iframe {
  min-width: 80% !important;
  width: 100% !important;
}
```

**为什么用属性选择器 `[class*="battle"]`**:
AI 会编任何变种 class(`custom-battle-review`、`my-battle-card`、`battle-wrapper` 等),用 `[class*="battle"]` 可以**一次性捕获所有带 "battle" 字眼的 class**,不用为每个变种单独写规则。

---

## 三、CSS 演进中踩过的坑(避坑笔记)

### 坑 1:属性选择器 specificity 比 class 高

```css
.custom-battle-title { min-width: 280px !important; }                    /* (0,1,0) */
[class^="custom-"][class*="battle"] { min-width: 0 !important; }         /* (0,2,0) */
```

两条都 `!important` 时,后者 specificity 高赢。前一条被覆盖成 0,白写了 280。**用 !important 不能解决优先级打架**。

### 坑 2:`.mes_text details` 选择器过宽

原本想"兜所有消息里的 details 都保持可用宽度",但会把**推理块 / 思维链 / 小总结**等非 battle 折叠框一起撑到 280px。**如果只想管 battle 相关,不要用过广的元素选择器**。

### 坑 3:注释跟代码不符很危险

一条规则注释说"覆盖 flex-direction",实际里只有 `min-width` 和 `max-width`。半年后看自己都看不懂。**要么改注释,要么改代码**。

### 坑 4:word-break 和 overflow-wrap 的区别

- `word-break: keep-all` → CJK 不在字符间断(比 `normal` 更严格)
- `overflow-wrap: break-word` → 允许长单词在容器边界断(不会溢出)
- 常用组合 **`keep-all + break-word`** = "中文整体不断,英文按词断" —— 最适合中英混排

---

## 四、完整验证

### 最终 Console 测试结果

```
min-width: 160px | white-space: nowrap | width: 160px   ← battle-title 层已修
竖排嫌疑 TOP 5:
  #1 details.custom-battle-review > summary > p (42×1681px, 比例 40.5)  ← AI 自创
  #2~#5 都是同一 .custom-battle-review 下的 <p>
iframe #0: 0 × 0px                                     ← iframe 没介入,不是凶手
mes 57 .mes_text: 841 × 4849px                         ← 消息容器本身不窄
```

关键信号:
- **`battle-title` (我修的)已正确** → 模板修改生效
- **`custom-battle-review` 是 AI 自创**,仓库零定义 → 必须用 Custom CSS 兜底
- **iframe 0×0** → JS-Slash-Runner 这次没介入
- **mes_text 841px** → 消息宽度充足,竖排是 AI HTML 内部 `<summary>` 的 flex 压扁子元素造成

### 粘完 Custom CSS 后

用户反馈:**"生效了"**。✅

---

## 五、永久运维须知

### 如果换 UI 主题

Custom CSS 跟当前主题**绑定**(存在 `data/default-user/settings.json` 的 `power_user.custom_css` 字段)。换主题后**这段 CSS 不会丢**(不是存在主题 json 里的)。但如果是**换电脑 / 换 SillyTavern 实例**,要重新粘这段。

### 如果 AI 又编出新 class

如果某天看到**又竖排了**,大概率是 AI 编了一个**既不含 "battle" 也不含 "review"** 关键字的新 class。诊断:跑附录脚本 A,看 TOP 5 路径里新 class 是什么,然后在 CSS 规则 4 的 `[class*="battle"], [class*="review"]` 后面加一条 `[class*="新关键字"]` 即可。

### 如果 JS-Slash-Runner 更新后 iframe 变真的 0×0 以上

现在 iframe 是 0×0 不起作用。但如果扩展升级后重新启用 iframe 渲染,可能宽度还是会被压。规则 5 已经给了 `min-width: 80%; width: 100%` 兜底,不用再改。

### 如果潮汐预设作者推新版覆盖了 replaceString

修复 1 的 8 处改动会丢。两种应对:
- (a) 导入新版后重新手动打补丁(参考本 md)
- (b) **彻底不改预设文件,只靠 Custom CSS 兜底**(修复 3 单独就足够)—— 推荐这个,因为 Custom CSS 不会被预设覆盖

---

## 六、不该做的事

1. ❌ **不要删 mes 57** —— 没必要,Custom CSS 兜底已经让它正常显示
2. ❌ **不要关 `🧠 潮汐散装思考` / `🎯 输出格式` prompt** —— 这是预设核心
3. ❌ **不要关 `05-潮汐混战` / `小人工坊可视化` 正则** —— 负责把 AI 注释转可见折叠框
4. ❌ **不要禁用 JS-Slash-Runner** —— 这次诊断证明它不是凶手
5. ❌ **不要用 `!important` 暴力堆规则** —— specificity 打架时反而会互相覆盖
6. ❌ **不要写过广的选择器**(如 `.mes_text details`)—— 会误伤其他 UI

---

## 七、附录:诊断过程的关键脚本

### 脚本 A:定位竖排嫌疑 TOP 5(本次功臣)

```js
(() => {
  const suspects = [...document.querySelectorAll('.mes_text *')]
    .map(el => {
      const r = el.getBoundingClientRect();
      return { el, r, ratio: r.height / Math.max(r.width, 1) };
    })
    .filter(x => x.r.width > 0 && x.r.width < 80 && x.r.height > 200 && x.ratio > 3)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5);

  console.log('=== 竖排嫌疑 TOP 5 ===');
  suspects.forEach(({ el, r, ratio }, i) => {
    const cs = getComputedStyle(el);
    let path = [], cur = el;
    while (cur && cur !== document.body) {
      path.unshift(`${cur.tagName.toLowerCase()}${cur.className && typeof cur.className === 'string' ? '.' + cur.className.trim().split(/\s+/).slice(0,2).join('.') : ''}`);
      cur = cur.parentElement;
      if (path.length > 6) break;
    }
    console.log(`#${i + 1} 比例 ${ratio.toFixed(1)} | 宽 ${r.width.toFixed(0)}px 高 ${r.height.toFixed(0)}px`);
    console.log('  路径:', path.join(' > '));
    console.log('  class:', el.className);
    console.log('  display/flex/width:', cs.display, '|', cs.flexDirection, '|', cs.width);
    console.log('  overflowWrap/wordBreak/whiteSpace:', cs.overflowWrap, '|', cs.wordBreak, '|', cs.whiteSpace);
    console.log('  父宽:', el.parentElement?.getBoundingClientRect().width.toFixed(0) + 'px');
  });

  console.log('\n=== iframe 宽度状态 ===');
  document.querySelectorAll('iframe').forEach((f, i) => {
    const r = f.getBoundingClientRect();
    console.log(`iframe #${i}: ${r.width.toFixed(0)} × ${r.height.toFixed(0)}px`);
  });
})();
```

**验收标准**:TOP 5 应该是空列表或比例都 < 3(没有明显窄高元素)。

### 脚本 B:抓现场 HTML

```js
(() => {
  const bad = document.querySelector('details.custom-battle-review, details[class*="battle"], details[class*="review"]');
  if (!bad) return console.log('没竖排现场');
  console.log('outer:', bad.outerHTML.slice(0, 2000));
})();
```

### 脚本 C:枚举样式表来源(排查扩展注入)

```js
for (const sheet of document.styleSheets) {
  try { console.log(sheet.href || '(inline)', '— rules:', sheet.cssRules.length); }
  catch { console.log(sheet.href || '(inline)', '— CORS blocked,可能是扩展'); }
}
```

输出里有 `chrome-extension://` = 浏览器扩展在注入。**本次诊断结果:没有**。

---

## 八、附录:SillyTavern 预设架构参考

### 预设 regex 脚本的 5 个存储位置(重要)

| # | 位置 | 作用 |
|---|---|---|
| 1 | 预设 JSON `prompts[MacroNest_false].content` | SPreset 配置字符串(月相主题激活时读) |
| 2 | 预设 JSON `prompts[MacroNest_true].content` | SPreset 配置字符串(潮汐主题激活时读) |
| 3 | 预设 JSON `extensions.regex_scripts` | SillyTavern 原生 regex 存储 |
| 4 | 预设 JSON `extensions.SPreset.RegexBinding.regexes` | SPreset 扩展自己的 regex 存储 |
| 5 | `data/default-user/settings.json` 的 `oai_settings.extensions.*` | **运行时工作副本**,启动时实际读的 |

**改 regex 必须同步改全部 5 处**,且**改之前要停 SillyTavern**(运行中会把内存数据周期性写回覆盖磁盘)。

### 参考文档

预设作者在仓库根目录提供的 `潮汐预设-HTML注释可见化改造说明.md` 正式描述了这个 4+1 同步架构及其原因。涉及 regex 改动时先读它。

### JS-Slash-Runner 的副作用

第三方扩展 `scripts/extensions/third-party/JS-Slash-Runner/`,别名"酒馆助手" / "TavernHelper"。

- 每条消息包装成独立 iframe/沙盒 → 产生大量 inline `<style>`(实测 1168 个)
- iframe 宽度在某些状态可能压到 ~45px
- 模板如用 `flex-direction: column` 放在此类 iframe 里,CJK 会逐字竖排

**这次诊断中它不是凶手**(iframe 0×0),但历史经验上**值得怀疑**。

---

## 九、附录:终端字体问题(跟 SillyTavern 无关)

Claude Code CLI 看中文是彩色方块 = 终端字体缺 CJK 字形。

**Windows Terminal**:Settings → 当前 profile → Appearance → Font face → 改成 `Cascadia Code NF` / `Sarasa Mono SC` / `Microsoft YaHei UI` / `Noto Sans Mono CJK SC` 之一。
**VS Code 集成终端**:`Ctrl+,` → 搜 `terminal.integrated.fontFamily` → `'Sarasa Mono SC', 'Cascadia Code', 'Consolas', monospace`。
**验证**:`echo 中文测试 UTF-8` 输出正常汉字即可。

---

*诊断过程总时长约 2 小时,经历 3 个阶段:*
*阶段 1 — 初步认定是 Custom CSS / 主题 bug → 否定*
*阶段 2 — 锁定潮汐预设 `battle-title` 模板布局 bug → 改 replaceString → 部分有效*
*阶段 3 — 发现 AI 自创 `custom-battle-review` 绕过正则 → Custom CSS 通配兜底 → 完全解决*

*最终方案是修复 3(Custom CSS 兜底)单独就足够对抗所有 AI 自创变种,修复 1(模板 replaceString)和修复 2(主题变量)是锦上添花但不是必须。*

---

## 十、v4 更新(2026-04-19 晚):流式 partial state 才是第二类真凶

v3 的 Custom CSS 兜底对**已完成渲染**的 `custom-battle-review` 折叠框有效(历史 1200+ 条消息显示正常),但对**正在流式生成中**的潮汐涌动折叠框**完全无效**。用户反馈的关键线索是:**"只有潮汐涌动在生成时竖排,生成完后就正常"**——这句话把诊断从 CSS/DOM 层面推翻,转到 regex 流式管线层面。

### 真正的根因:regex 00a 的流式贪婪

AI 按 prompt 输出 `Basic_confirmation: <思维链正文>\n</基础确认>` 这段,被两条潮汐主题 regex 接力处理:

- **`00a-思维链生成中-潮汐主题`**:流式期间(`</基础确认>` 还没落地)触发,把 `Basic_confirmation: ...` 实时包装成潮汐涌动的 HTML 盒子
- **`00b-思维链完整-潮汐主题`**:消息完成后(`</基础确认>` 或 `<content>` 已出现)触发,产出最终干净的 HTML 盒子

### 为什么 00b 没事、00a 有事——三层对比

| 维度 | 00a(有问题) | 00b(安全) |
|---|---|---|
| findRegex 终止要求 | 仅负向先行 `(?!.*(?:\n</基础确认>\|<content>))`,**非必需断言** | `\s*\n(?:</基础确认>\|(?=<content>))` **必需匹配** |
| `$1` 捕获算法 | `(.+)` **裸贪婪**,吞到文本末尾 | `((?:(?!\n...).)+)` **tempered greedy**,每字符排查终止符 |
| 触发时机 | 流式期间,每个 token 都会触发重新 match,DOM 反复 reflow | 消息完成后才触发,DOM 一次性静态 parse |
| 后果 | `$1` 在流式某瞬间吞进 AI 已输出的 orphan HTML 源码,塞进 `<div>$1</div>` 被浏览器当真 HTML parse,DOM 嵌套扭曲 → CJK 被挤进 flex column 逐字竖排 | `$1` 永远是干净文本,HTML 一次成型 |

### "之前正常、现在异常"的时间机理

- **之前正常**:AI 按 prompt 老实把思维链写在 HTML 注释(`<!-- 工头潮汐 -->`)里。注释浏览器不可见——**用户从看不到流式 partial state**
- **现在异常**:(A) AI 流式节奏/服从性变了,Basic_confirmation 正文变长触发 00a 窗口拉长;或 (B) 潮汐预设新增/升级了 00a+00b 这套 regex 流水线,把原本 invisible 的注释方式换成了 visible 的 HTML 实时包装。两种情况都让 partial DOM 从隐形变成暴露

### 存储位置修正:**6 处,不是 5 处**

第七章原本记录的"4+1=5 处"并不全,实际是 **3+3=6 处**:

| # | 文件 | 路径 | 用途 |
|---|---|---|---|
| 1 | 预设 JSON | `extensions.regex_scripts[scriptName=00a]` (~2286 行) | SillyTavern 原生管线读 |
| 2 | 预设 JSON | `extensions.SPreset.RegexBinding.regexes[scriptName=00a]` (~2658 行) | **SPreset 扩展(酒馆助手系)读** |
| 3 | 预设 JSON | `prompts[name="SPreset配置"].content` 字符串内嵌式 regex 定义 (~1614 行,长 JSON-escaped string) | SPreset 主题切换时读 |
| 4 | settings.json | `extensions.regex_scripts[scriptName=00a]` (~3447 行) | #1 的运行时副本 |
| 5 | settings.json | `extensions.SPreset.RegexBinding.regexes[scriptName=00a]` (~3819 行) | #2 的运行时副本 |
| 6 | settings.json | SPreset 配置 content 字符串 (~2693 行) | #3 的运行时副本 |

### 致命陷阱:只禁一边等于没禁

`regex_scripts` 数组和 `SPreset.RegexBinding.regexes` 数组是**两套独立存储**,SillyTavern 原生和 SPreset 扩展**各读各的**。本轮调查前,#1、#4 已经是 `disabled: true`,但 #2、#5 **仍是 `disabled: false`**,而且 findRegex 还是最原始的纯贪婪 `.+$` 版——**所以用户以为关掉 00a 了,实际 SPreset 还在后台用最差的 regex 跑它**。这很好地解释了为什么"以为修过、但症状依然"。

**铁律**:禁用 SillyTavern regex **务必通过 UI 操作**(UI 会同步两套存储),手改 JSON 要么全改,要么不改。

### findRegex 改写的死胡同

本轮试过一版"改进" findRegex 来缩短 partial 窗口:

```
/(?:Basic_confirmation):?\s*([\s\S]+?)(?=\n<\/基础确认>|\n<content>|$)/si
```

用户实测"不行"。**原因在 `$` 终止符**:`[\s\S]+?` 是非贪婪,找能让前瞻成立的**最短**匹配。但前瞻里有 `$`(文本末尾)作为备选——流式期间终止符没到,`$` 总是能成立(文本总有末尾)。非贪婪从最短扩展,每步尝试前瞻,直到扩到文本末尾 `$` 成立——**行为和原版 `.+` 贪婪等价**。

**教训**:**regex 的 `$` 作为备选终止符 + 非贪婪 = 在流式期间退化成贪婪**。这不是 regex 写法不够巧,是语义硬约束。

### 设计层面的本质矛盾

> 要 00a 在流式期间显示美化框 ⟺ 必须在终止符未到时就开始 match ⟺ `$1` 必然扩张到当前流末尾 ⟺ partial DOM 必然暴露

**regex 层面无解**。三条候选方案:

| 方案 | 机理 | 副作用 |
|---|---|---|
| tempered greedy `(?!\n<).` | `\n<` 一出现就停,比原版提前 ~7 字符触发停止 | 思维链正文若有 `\n<em>` / `\n<br>` 等行首 `<` 会误切;partial 窗口缩短但不消除 |
| **禁用 00a**(本轮选择) | 流式期间不产出美化框,原文显示 `Basic_confirmation: ...`;完成后 00b 产出干净框 | 流式视觉朴素,但结构稳定 |
| CSS `overflow: hidden; max-height: 72px` 兜底 | 不改 regex,流式溢出视觉上裁掉 | 零语义风险,但 DOM 实际上还是错乱的(只是被裁) |

本次用户选择方案 2,**在 SillyTavern UI 里手动禁用 00a**,UI 同步了 `regex_scripts` 和 `SPreset.RegexBinding.regexes` 两套存储,避免再踩只禁一边的坑。

### 给未来自己的提醒

1. **"生成时 X、生成完恢复"的视觉 bug,第一嫌疑永远是 regex 流式管线**——不是 CSS、不是 AI 自创 class、不是扩展注入。特征是:DOM 里已完成的元素正常,只有正在生成的元素异常。Custom CSS 对前者有效、对后者必然无效,因为 CSS 作用于稳定 DOM,管不了流式 incremental parser 的中间态
2. **regex 存储是 6 处不是 5 处**。更新第七章。改 regex 优先用 UI(自动同步两套存储),手改 JSON 要注意 `regex_scripts` 和 `SPreset.RegexBinding.regexes` 是两套,SPreset 扩展读后者
3. **对抗流式 DOM 污染的 regex 设计三要素**:(a) 必需终止断言,不用可选负向先行;(b) tempered greedy 替代裸 `.+`;(c) **`$` 不能作为备选终止符**,它会让非贪婪退化成贪婪。做不到三条的 regex 注定在流式期间暴露 partial state
4. **AI 在思维链里 echo HTML 源码的机理**:如果 prompt 或 few-shot 给了 HTML 模板示例,AI 有几率在思考"该产生什么输出"时把 HTML 字符原文引用到思维链正文里。这些字符进 `$1` → 进 `<div>$1</div>` → 被浏览器当真 HTML parse → 叠加流式 partial 的未闭合标签 → DOM 嵌套崩溃 → CJK 逐字竖排
5. **v3 "已解决" 结论的校正**:Custom CSS 只对已稳定 DOM 起作用,对流式中间态无力。v3 解决的是 class 不一致问题(AI 自创 `custom-battle-*` 绕过 CSS 命中),v4 解决的是流式 partial state 问题(regex 00a 在终止符未到时吞进 orphan HTML)。两层根因叠加,必须两层都修
6. **找到"潮汐涌动"这个词的出处**:它是 00a/00b replaceString 里硬编码的标签文本 (`<span>潮汐涌动</span><span>思绪汇聚</span>`)。看到"潮汐涌动"就等于看到 Basic_confirmation 思维链的 regex 包装在工作——这条可以当 signpost 用于未来快速定位问题源
