# 安装与排障

[返回功能介绍](../README.md) · [操作指南](usage.md) · [设置参考](settings.md)

## 环境要求

- Windows 10 2004+ 或 Windows 11，系统提供 .NET Framework 4.8。
- DeepSeek Harness 0.2.0-rc.2 或更新版本。
- 需要截图时，选用支持图片输入的模型。纯文本模型可通过 UI Automation 读文字和定位控件，效果取决于目标应用暴露的无障碍信息。

## 安装

**桌面版**打开 **插件 → 添加插件**，输入 `@copylee/dsh-computer-use`，安装后启用。**Web profile** 可用以下命令安装。

```sh
dsh plugin --profile web add @copylee/dsh-computer-use@latest
```

如果同时启用了其他电脑操控插件或 skill，先停用重叠的工具，避免模型收到多套操作规则。

## 第一次使用

在会话里试一句“打开记事本，输入三条待办”，按提示批准记事本的操控权限。需要查看光晕或进度卡片时，可在 **设置 → 电脑控制 → 预览效果** 中预览约 4 秒。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 工具提示未获授权 | 在会话中批准目标应用。检查它是否在禁用列表中。 |
| 模型说看不到按钮或输入框 | 将目标窗口置于前台，再读取控件。画布、游戏和部分自绘应用可能只适合截图定位。 |
| Web GUI 无法恢复焦点 | 从 Web GUI 活动标签发起任务。如果走反代或自定义域名，请设置 [`harnessUrl`](settings.md#web-gui-地址)。恢复标签依赖浏览器提供的 UI Automation 信息。 |
| 希望沿用当前 Chrome | 可以说“用当前打开的 Chrome，在同一窗口的新标签打开这个网址”。窗口和活动标签必须能通过 UI Automation 核验。 |
| 默认浏览器无法显式新开窗口 | 当没有可复用窗口时，使用 Chrome、Edge、Brave、Vivaldi、Chromium 或 Firefox 等支持独立窗口启动参数的默认浏览器。 |
| 截图或输入异常 | 关闭 **进程内截图与输入**，让辅助程序接管。开启 Smart App Control 时，辅助程序可在系统 PowerShell 中加载。 |
| 管理员窗口、UAC 或锁屏无法操作 | 由用户直接处理。系统限制普通权限进程对这些窗口的操作。 |
