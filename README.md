# B站助手 (bili-assistant)

一个基于 Electron 的 Bilibili 自动化桌面工具。

- 支持账号登录态检测
- 支持关注作者检查
- 支持每日任务自动化（观看、分享、投币）
- 支持大会员每日经验领取
- 内置浏览器实时显示执行页面

## 功能说明

当前自动化流程包含以下步骤：

1. 关注检查（指定 UID）
2. 每日观看视频（真实播放）
3. 每日分享视频（API 上报）
4. 每日投币（API 上报）
5. 大会员每日签到（通过每日经验接口）

说明：
- 观看步骤使用真实播放逻辑，不做点击模拟。
- 若视频未自动播放，会自动尝试恢复播放，必要时刷新页面重试一次。
- 其它步骤优先使用 API，降低页面交互不稳定性。

## 技术栈

- Electron
- 原生 HTML/CSS/JavaScript

## 目录结构

```text
bili-assistant/
  assets/
    icon.svg
    icon.png
    icon.ico
  index.html
  styles.css
  renderer.js
  main.js
  preload.js
  webview-preload.js
  package.json
```

## 环境要求

- Node.js 18+
- npm 9+
- Windows 10/11（当前发布脚本面向 Windows）

## 本地开发

```bash
npm install
npm start
```

## 构建与发布 ZIP

### 一键生成 Windows release ZIP

```bash
npm run release:win
```

该命令会执行：

1. `npm run build:win` 生成打包目录
2. `npm run release:zip` 压缩为 ZIP

输出文件：

- `release/bili-assistant-win32-x64.zip`

## GitHub 发布建议流程

1. 推送代码到 GitHub 仓库
2. 在仓库页面创建一个新 Release（例如 `v1.0.0`）
3. 上传 `release/bili-assistant-win32-x64.zip` 作为 Release 资产
4. 在 Release 描述中说明更新内容与注意事项

## 图标资源

- `assets/icon.svg`：矢量源文件
- `assets/icon.png`：页面/文档使用
- `assets/icon.ico`：Windows 应用图标

## 风险与合规提示

- 请仅用于自己的账号与合规场景。
- 平台接口与风控策略可能随时变化，功能可能需要跟进维护。
- 建议控制执行频率，避免高并发、高频调用。

## License

ISC
