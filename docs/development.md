# 开发与验证

[返回功能介绍](../README.md) · [Agent 工具](tools.md) · [数据与权限](privacy.md)

## 运行结构

- **DSH Host** 加载 `lib/index.js`，负责工具、审批、系统提示和操控生命周期。
- **进程内 worker** 加载 DSH 自带的 koffi，处理截图、显示器和窗口查询，以及浮层未显示时的输入。
- **Windows 辅助程序** 通过标准输入输出交换逐行 JSON，负责 UI Automation、剪贴板和控制浮层等。首次运行使用 Windows 自带的 .NET Framework 编译器编译 [C# 源码](../helper/CuHelper.cs)，随后复用缓存。启用 Smart App Control 时，可以在系统 PowerShell 中加载该程序。

## 本地检查

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

在 Windows 上构建完成后，可以运行实机检查。

| 命令 | 检查内容 |
| --- | --- |
| `node scripts/helper-smoke.mjs` | 辅助程序编译、截图和浮层。加 `--notepad` 用临时文件验证中文输入。 |
| `node scripts/uia-chromium-smoke.mjs` | 隔离浏览器配置中的控件读取、UIA 动作和标签恢复。可传入 Chrome 或 Edge 的 exe 路径。 |
| `node scripts/native-smoke.mjs --notepad` | 对比 koffi 与辅助程序路径。在 DSH 运行时下运行，或设置 `DSH_KOFFI_PATH`。 |

## 本地联调

在 DSH 桌面版的 **添加插件** 中填入本仓库目录，以 link 方式加载。修改后执行 `pnpm build`，重启 DSH 即可加载新构建。

[原生辅助程序实验记录](koffi-spike.md) · [0.6.0 历史验证记录](verification-0.6.0.md)
