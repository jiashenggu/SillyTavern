# 潮汐预设 HTML 注释可见化改造

## 目标

让模型写作过程中小人工坊的 HTML 注释评论（`<!-- 工头潮汐：... -->` 等）在页面上保持可见（折叠面板形式），同时不污染下一轮 AI 推理的上下文。

## 问题分析

### 问题一：正则删除

`隐藏辅助标签` 正则的 `findRegex` 中包含 `<!--[\s\S]*?-->`，且同时设置了 `markdownOnly:true` + `promptOnly:true`。

根据 SillyTavern 正则引擎（`public/scripts/extensions/regex/engine.js:348-354`）的 **OR 逻辑**判断：

```javascript
(script.markdownOnly && isMarkdown) ||   // 分支A：页面渲染时执行
(script.promptOnly && isPrompt) ||        // 分支B：提示词构建时执行
(!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt) // 分支C：默认
```

两个标志都为 `true` → 分支A和B都能命中 → **页面渲染和提示词构建两个阶段都执行删除**。

### 问题二：浏览器隐藏

即使正则不删除注释，`<!-- ... -->` 是 HTML 原生注释语法，**浏览器天然不渲染**。
需要用正则将注释**转换为可见的 HTML 元素**（折叠面板），而不仅仅是"不删除"。

流式传输时的表现：
- **流式时**：关闭标签 `-->` 尚未生成，浏览器当作普通文本 → 可见
- **生成完成后**：完整的 `<!-- ... -->` 被浏览器识别为注释 → 消失

## 修改位置（共 5 处 × 多个文件）

SPreset 扩展使预设 JSON 中存在多处正则脚本定义，修改时必须**全部同步**：

| # | 位置 | 说明 |
|---|------|------|
| 1 | `prompts[108]` 的 `content`（SPreset配置，MacroNest:**false**，月相主题） | SPreset 在 MacroNest 关闭时读取此配置 |
| 2 | `prompts[114]` 的 `content`（SPreset配置，MacroNest:**true**，潮汐主题） | SPreset 在 MacroNest 开启时读取此配置 |
| 3 | `extensions.regex_scripts` | 预设级正则脚本（SillyTavern 原生） |
| 4 | `extensions.SPreset.RegexBinding.regexes` | SPreset 扩展的正则绑定 |
| 5 | `data/default-user/settings.json` 中的 `oai_settings.extensions` | **酒馆运行时的工作副本**（见下方重要说明） |

> **注意**：两个 SPreset配置 prompt **不是相同配置的副本**，而是两套不同的主题方案。
> MacroNest:false = 月相主题（19+ 条脚本），MacroNest:true = 潮汐主题（17+ 条脚本）。
> 当前预设默认使用 MacroNest:true（`extensions.SPreset.MacroNest: true`），
> 可在 SPreset 设置面板的「启用宏嵌套」开关切换。

## 修改内容

### 1. `隐藏辅助标签` — 移除注释匹配（4 处 + settings.json）

从 `findRegex` 中移除 `|<!--[\s\S]*?-->` 段：

```
# 修改前
/(<content>|<\/content>)|(<safe>[\s\S]*?<\/safe>)|(<recap>|<\/recap>|<theater>|<\/theater>)|<parallel_world>|<\/parallel_world>|<!--[\s\S]*?-->|(<基础确认>|<\/基础确认>|极其)/gs

# 修改后
/(<content>|<\/content>)|(<safe>[\s\S]*?<\/safe>)|(<recap>|<\/recap>|<theater>|<\/theater>)|<parallel_world>|<\/parallel_world>|(<基础确认>|<\/基础确认>|极其)/gs
```

### 2. `干掉潮汐小人` — 新增 prompt 端注释清理（4 处 + settings.json）

在每处 `隐藏辅助标签` 之后插入，仅在构建提示词时删除注释：

```json
{
    "scriptName": "干掉潮汐小人",
    "findRegex": "/<!--[\\s\\S]*?-->/gs",
    "replaceString": "",
    "placement": [2],
    "markdownOnly": false,
    "promptOnly": true,
    "runOnEdit": true
}
```

### 3. `小人工坊可视化` — 新增页面端注释转折叠面板（4 处 + settings.json）

在每处 `05-潮汐混战` 之后插入，将小人注释转换为与潮汐混战同款的折叠面板：

```json
{
    "scriptName": "小人工坊可视化",
    "findRegex": "/<!--\\s*(\\S*潮汐\\S*)[：:]\\s*([\\s\\S]*?)\\s*-->/gs",
    "replaceString": "（折叠面板 HTML，标题=$1，内容=$2，样式同05-潮汐混战）",
    "placement": [2],
    "markdownOnly": true,
    "promptOnly": false,
    "runOnEdit": true
}
```

**正则说明**：
- `(\S*潮汐\S*)` — 匹配含"潮汐"关键词的标签名（工头潮汐、活人潮汐、织线潮汐等）
- `[：:]` — 匹配中文或英文冒号
- `([\s\S]*?)` — 非贪婪匹配注释内容
- 不会误匹配模板中的普通 HTML 注释（如 `<!-- 左侧细线 -->`），因为它们不含"潮汐"
- 在 `05-潮汐混战` 之后执行，`<!-- 收工混战：... -->` 已被处理，不会重复匹配

## 正则执行流程

### 页面渲染时 (`isMarkdown`)

```
原始文本
  ↓ 05-潮汐混战 (markdownOnly)     → <!-- 收工混战：... --> 转为折叠面板
  ↓ 小人工坊可视化 (markdownOnly)   → <!-- XX潮汐：... --> 转为折叠面板
  ↓ 隐藏辅助标签 (markdownOnly)     → 删除 <content>/<safe> 等标签（不再匹配注释）
  ↓ 干掉潮汐小人 — 跳过（promptOnly）
渲染结果：注释以折叠面板形式可见
```

### 提示词构建时 (`isPrompt`)

```
原始文本
  ↓ 05-潮汐混战 — 跳过（markdownOnly）
  ↓ 小人工坊可视化 — 跳过（markdownOnly）
  ↓ 隐藏辅助标签 (promptOnly)       → 删除 <content>/<safe> 等标签
  ↓ 干掉潮汐小人 (promptOnly)       → 删除所有 <!-- ... --> 注释
提示词结果：AI 看不到注释
```

## 涉及的文件

修改需同时应用到**三个文件**：

| 文件 | 作用 |
|------|------|
| `潮汐Chaoxi   改 (1).json`（根目录） | 备份/导入源 |
| `data/default-user/OpenAI Settings/潮汐Chaoxi   改 (1).json` | 预设数据文件 |
| `data/default-user/settings.json` | **关键：酒馆运行时的工作副本** |

## 重要：settings.json 是运行时数据源

**酒馆启动时优先从 `settings.json` 的 `oai_settings.extensions` 读取正则脚本的工作副本，而不是从预设文件重新加载。** 这意味着：

1. **仅修改预设文件不够** — 必须同时修改 `settings.json`
2. **必须先停酒馆再改文件** — 运行中的酒馆会周期性将内存数据写回 `settings.json`，覆盖磁盘修改
3. **通过 UI 导入预设无法可靠更新正则** — 导入会更新预设文件和内存，但 `saveSettingsDebounced` 可能用旧的 `oai_settings` 覆盖

**正确的修改流程**：停止酒馆 → 修改三个文件 → 启动酒馆

## 备注

- `05-潮汐混战` 仍然单独将 `<!-- 收工混战：... -->` 转换为折叠面板，不受影响
- 原版预设的 MacroNest:false 变体本就自带 `干掉潮汐小人` 脚本，本次修改使 MacroNest:true 变体也具备相同行为
- 全局正则脚本（`settings.json` 的 `extension_settings.regex` 字段）当前为空，无需修改
- `小人工坊可视化` 仅匹配含"潮汐"关键词的注释；如需匹配其他格式的注释，需调整 findRegex
