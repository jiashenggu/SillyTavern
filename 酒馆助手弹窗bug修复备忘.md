# 酒馆助手(JS-Slash-Runner) 预设脚本弹窗重复 Bug 修复

## 问题

预设 "潮汐Chaoxi 改 (1)" 每次刷新页面都会弹窗询问是否启用嵌入式脚本，即使点了"是"也无效。其他预设正常，只弹一次。

## 原因

酒馆助手扩展在 `use_check_enablement_popup.ts` 的 `SETTINGS_UPDATED` 回调中，有一段清理逻辑会在每次页面加载时执行：

```typescript
const existing_presets = new Set(preset_manager.getAllPresets());
_.remove(global_settings.settings.script.popuped.presets, preset => !existing_presets.has(preset));
_.remove(global_settings.settings.script.enabled.presets, preset => !existing_presets.has(preset));
```

`getAllPresets()` 在某些时序下未返回该预设名，导致用户点"是"后存入的记录被清理掉，下次加载又弹窗。

v4.7.12 已用相同方式修过角色卡的同种 bug，但预设的清理逻辑未一并修复。

## 修复方式

删除上述 3 行清理代码。修改了两个文件：

1. **源码** `src/panel/script/use_check_enablement_popup.ts` (第 18-20 行)
2. **编译产物** `dist/index.js` (对应的压缩代码)

预设的删除和重命名已通过 `PRESET_DELETED` 和 `PRESET_RENAMED_BEFORE` 事件单独处理，不依赖这个批量清理。

## 注意

- 扩展 `manifest.json` 中 `auto_update: true`，如果作者发布新版本会覆盖 `dist/index.js`
- 截至远程最新版 (commit d3fcc04)，此 bug 仍未修复
- 如被覆盖，需在 `dist/index.js` 中搜索 `getAllPresets` 附近的 `popuped.presets`，删除对应的清理代码块：
  ```
  // 搜索并删除这段(压缩后的形式)：
  const t=new Set(Fm.getAllPresets());_.remove(n.settings.script.popuped.presets,e=>!t.has(e)),_.remove(n.settings.script.enabled.presets,e=>!t.has(e)),
  ```
- 上游 issue 地址: https://github.com/N0VI028/JS-Slash-Runner/issues

## 修复日期

2026-04-05
