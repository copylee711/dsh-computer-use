# 🖱️ dsh-computer-use

[![npm](https://img.shields.io/npm/v/@copylee/dsh-computer-use)](https://www.npmjs.com/package/@copylee/dsh-computer-use)

让 DeepSeek Harness 直接操控你的 Windows 电脑：看屏幕、点鼠标、敲键盘，打开应用、切换窗口、读写剪贴板。控制期间屏幕四周会泛起**橙色光晕**，顶部出现“**DeepSeek Harness 正在操控你的电脑**”提示条，DeepSeek Harness 自己缩成右下角的置顶悬浮卡片，让你同时看到操作过程和 AI 的输出。按 **Esc** 暂停 / 继续，点“停止”结束本轮。

| 功能 | 说明 |
|---|---|
| 截图即坐标系 | 模型只用最近一张截图的像素坐标，DPI、缩放、多显示器偏移全部由插件换算，高分屏（200% 缩放）也点得准 |
| 动作后自动回传截图 | 点击 / 输入 / 按键 / 滚动后，**等画面不再变化**（页面加载、动画结束，最多约 2.5 秒）再截图；`wait` 也直接带回截图，“等一下再看”只需一步，而且画面一静止就提前结束，不会死等满时长；画面与上一张截图完全相同时不再发图，只告诉模型“没有可见变化”，省 token |
| 批量动作 | `computer_batch` 一次执行“点输入框 → 输入 → 回车”等多步，最后只截一张图 |
| 按应用授权 | 先 `request_access` 列出要操控的应用，经 DSH 原生审批后才能操作；也可改为“全部允许” |
| 不会操作自己 | 永远拒绝向 DeepSeek Harness 自身窗口输入；常见密码管理器默认禁止，可再自定义禁用列表 |
| 正在控制的提示 | 橙色光晕 + 胶囊提示条（显示当前动作），**不会出现在截图里** |
| 悬浮卡片 | 操控期间 DeepSeek Harness 窗口缩成右下角置顶卡片，结束后自动恢复原尺寸、位置和最大化 / 最小化状态（也可选最小化或不动）。卡片只给你看：AI 的截图里看到的是卡片下面的内容（通过 Windows 放大镜接口截图时把卡片排除在外，不闪烁；该接口不可用时退回为截图瞬间让卡片透明约 20 毫秒），点击和滚动也直接穿透卡片，卡片不会挪位置 |
| 暂停与停止 | 你亲手按 **Esc** 暂停（AI 停在下一步之前），再按 Esc 或点“继续”恢复，对话不会被中断；点“停止”才结束本轮。插件自己发出的 Esc 不会误触发 |
| 你随时可以插手 | 你用键盘打字时 AI 自动暂停，停手 1.5 秒后继续（单按 Shift / Ctrl 等修饰键不算）；你切换或打开了别的窗口，AI 下一步不会盲目执行，而是先看新截图再决定。你只是点进 DSH 卡片看对话时不算切换，AI 的按键会自动回到它正在操作的窗口。鼠标移动不会触发，避免误触 |
| 中文输入 | Unicode 直接输入，不受输入法状态影响；长文本走剪贴板粘贴，剪贴板文本统一为 CRLF，粘贴到 Obsidian 等应用不丢换行 |
| 不弄乱剪贴板 | 插件写入剪贴板的内容不进 Windows 剪贴板历史（Win+V）和云剪贴板；粘贴后按原样恢复你的剪贴板（图片、文件也保留）；AI 用 `clipboard` 工具写过剪贴板的，本轮结束后自动还原（期间你自己复制了新内容则不动） |
| 打开应用 | `open_application` 同时搜索开始菜单和桌面快捷方式（含公共桌面），便携软件也能按名字打开 |
| 看不见图的模型 | `ui_elements` 用 Windows UI Automation 列出可点击元素和坐标，纯文本模型也能用 |
| 零原生依赖 | 首次使用时用 Windows 自带的 .NET Framework `csc.exe` 编译一个小 helper（约 1 秒，之后缓存），不需要 node-gyp、不受 Electron ABI 影响 |

## 安装

DSH 桌面版：**插件 → 添加插件**，输入 `@copylee/dsh-computer-use`，安装后启用。

命令行（web 等其他 profile）：

```bash
dsh plugin --profile web add @copylee/dsh-computer-use@latest
```

要求：Windows 10 2004+ / Windows 11（自带 .NET Framework 4.8），DSH 0.2.0-rc.2 或更高。截图需要**支持图片输入的模型**（如 DeepSeek V4.1 Flash）；纯文本模型会自动改用 `ui_elements`。

> 如果之前装过其他 computer-use 插件或 skill（例如 `dsh-computer-use-win`、Hermes 的 computer-use skill），建议先停用，避免工具和说明互相冲突。

## 用法

直接说要做什么就行，例如：

- 用 Chrome 打开 github.com
- 打开记事本，写一段会议纪要并保存到桌面
- 用计算器算一下 1234×5678

按应用授权模式下，模型会先请求操控对应应用，你在 DSH 里批准即可。会话权限为“完全权限”或“自动审查”（不弹审批）时，请求会被自动批准，但 DeepSeek Harness 自身和禁用列表里的应用仍然不可操作。

**随时按 Esc 暂停**，再按一次继续；点提示条上的“停止”结束本轮。想临时帮一把也可以直接上手：打字时提示条显示“你正在操作，已暂停”，AI 会等你停手；切到别的窗口后 AI 会先重新看屏幕。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `computer` | 单个动作：`screenshot` `left_click` `double_click` `triple_click` `right_click` `middle_click` `mouse_move` `left_click_drag` `left_mouse_down/up` `scroll` `type` `key` `hold_key` `wait` `zoom` `cursor_position`（沿用通用 computer-use 动作命名，模型上手即会） |
| `computer_batch` | 顺序执行多个动作，遇错即停，最后回传一张截图 |
| `open_application` | 按名称（“Chrome”“记事本”“微信”）、exe 路径或网址打开应用；已运行则切到前台 |
| `windows` | 列出窗口（含进程 exe 名）、聚焦 / 最小化 / 最大化 / 还原 / 关闭 |
| `ui_elements` | 前台窗口的 UI Automation 元素列表，坐标已换算到截图坐标系 |
| `clipboard` | 读 / 写剪贴板文本 |
| `switch_display` | 多显示器时切换截图所在屏幕 |
| `request_access` / `list_granted_applications` | 按应用授权 |

## 设置

在 **设置 → 电脑控制** 中修改，保存后下一步操作即生效。页面上还能看到运行状态（屏幕分辨率、缩放比例和实际发给模型的截图尺寸），并可点“预览效果”看 3 秒光晕和提示条：

| 选项 | 默认 | 说明 |
|---|---|---|
| 授权方式 | 按应用授权 | 或“全部允许” |
| 光晕与提示条 | 开 | 控制时显示橙色边框和提示条 |
| 提示条名称 | DeepSeek Harness | 显示为“<名称> 正在操控你的电脑” |
| 操控期间 DSH 窗口 | 悬浮卡片 | 悬浮卡片 / 最小化 / 保持不变，结束后自动恢复 |
| 操作后自动截图 | 开 | 关闭可省 token，但模型需要自己截图 |
| 等待稳定 | 400 ms | 动作后至少等这么久，之后画面静止即截图（最多约 2.5 秒） |
| 截图最长边 / 总像素 / JPEG 质量 | 1366 / 1.15MP / 80 | 越大越清晰、越费 token |
| 检测到你在操作时让出控制 | 开 | 键盘输入暂停、窗口被切换时重新看屏幕 |
| 键盘静止多久后恢复 | 1500 ms | |
| 禁止操控的应用 | 空 | 名称或 exe，如 `alipay` |

## 数据与隐私

- 截图只作为当前会话的图片附件发给你选择的模型，插件不上传、不保存到别处。
- helper 源码 `helper/CuHelper.cs` 随包发布，可自行审阅；编译产物缓存在 `%LOCALAPPDATA%\dsh-computer-use\`。
- 以管理员身份运行的窗口、UAC 弹窗、锁屏无法被控制（Windows UIPI 限制），遇到时模型会请你手动处理。
- 插件注入的系统提示要求模型不代填密码、支付信息、不处理验证码，遇到时交还给你。

## 工作原理

```
DSH Host (Electron, Node 模式)
 └─ lib/index.js  工具 / 审批 / 系统提示 / overlay 生命周期
     └─ cu-helper.exe（常驻，stdin/stdout 每行一个 JSON）
          Per-Monitor-V2 DPI 感知 · GDI 截图 + 缩放 + JPEG · SendInput 鼠标键盘
          窗口枚举与前置 · shell:AppsFolder 启动应用 · 剪贴板 · UI Automation
          分层窗口 overlay（WDA_EXCLUDEFROMCAPTURE）· 低级键盘钩子（只认物理 Esc）
```

## 开发

```bash
pnpm install
pnpm typecheck
pnpm test                               # vitest（mock helper，跨平台）
pnpm build                              # tsc → lib/types，tsdown → lib/index.js
node scripts/helper-smoke.mjs           # 本机实测：编译 helper、截图、overlay
node scripts/helper-smoke.mjs --notepad # 另外用临时文件测试中文输入
pnpm pack:check
```

本地联调：DSH 桌面版“添加插件”里填本仓库目录路径即可（以 link 方式安装），改完 `pnpm build` 后重启 DSH 生效。

### 发版

推送版本 tag 后，GitHub Actions（`.github/workflows/publish.yml`）通过 npm Trusted Publishing 自动发布并附带 provenance：

```bash
# 先把 package.json 的 version 改成新版本并合并到 main
git tag v0.1.1 && git push origin v0.1.1
```

## License

MIT
