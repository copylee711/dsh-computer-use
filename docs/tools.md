# Agent 工具

[返回功能介绍](../README.md) · [操作指南](usage.md) · [设置参考](settings.md)

| 工具 | 用途 |
| --- | --- |
| `computer` | 截图、点击、移动、拖动、滚动、输入、按键、等待和放大。 |
| `computer_batch` | 按顺序执行多个动作，遇错即停。默认在末尾回传一张截图。 |
| `ui_elements` | 读取窗口的 UI Automation 控件，包括打开的菜单。传入 `text: true` 读取窗口文字。 |
| `open_application` | 按应用名或 exe 路径启动应用，或聚焦已有窗口。可从系统托盘恢复应用。打开 HTTP(S) 地址时，优先在当前已核验且获准的 Chrome 窗口中开新标签。其他浏览器或明确要求 `new_instance: true` 时，使用默认浏览器的新窗口。 |

要沿用当前 Chrome，先按应用名聚焦它，再将网址传给 `open_application`。如果同一窗口里有本轮记录的 DSH Web 标签，插件只会操作新开的工作标签页面，标签栏、整窗快捷键和原 DSH 标签仍受保护。
| `windows` | 列出、聚焦、最小化、最大化、还原或关闭窗口。`tidy` 将原本最小化或在托盘的窗口放回原状态，并列出本轮打开的窗口。 |
| `clipboard` | 读写剪贴板文本。 |
| `switch_display` | 切换当前截图所在的屏幕。 |
| `request_access` / `list_granted_applications` | 申请目标应用的权限及查询授权状态。 |
| `app_skill` | 通过 `list`、`read`、`append`、`write` 管理应用操作笔记。单份上限 4000 字。 |

## 按名称或坐标定位

- `target: "保存"` 按可见名称匹配。`target: "按钮:保存"` 同时限定控件类型。
- `target: "id:NavTasksButton"` 或 `target: "#NavTasksButton"` 使用 `ui_elements` 返回的 AutomationId。多个控件匹配时，使用候选信息进一步区分。
- 普通单击优先使用控件支持的 UIA Invoke，输入优先使用 UIA 聚焦。控件明确缺少对应能力时才回退到重新定位后的坐标；语义动作的结果不明时，应先查看界面。
- 坐标以最新的全屏截图像素为基准。插件换算物理坐标、DPI 缩放和多显示器偏移。`zoom` 的局部截图有自己的坐标范围，不能直接作为后续点击坐标。

## 批量动作和条件等待

下面的批次填好字段、提交并等待成功提示，最后读出窗口文字。

```json
{
  "actions": [
    { "action": "type", "target": "输入框:报名姓名", "text": "演示访客" },
    { "action": "type", "target": "输入框:预约场次", "text": "周六上午" },
    { "action": "left_click", "target": "按钮:提交报名" },
    { "action": "wait", "until": "target:报名成功" }
  ],
  "finish": "text"
}
```

`wait` 可以等 `window:另存为`、`target:保存` 或 `text:报名成功`，也可以用 `gone: true` 等目标消失。文字等待读取开始等待时的窗口，可用时也核对浏览器标签。它依赖应用提供的文字信息。`computer_batch.finish` 支持 `screenshot`、`text` 和 `none`。单独调用 `ui_elements({ text: true })` 默认读取窗口文字的末尾 4000 字。

`computer` 支持的动作包括 `screenshot`、`zoom`、`cursor_position`、`left_click`、`double_click`、`triple_click`、`right_click`、`middle_click`、`mouse_move`、`left_click_drag`、`left_mouse_down`、`left_mouse_up`、`scroll`、`type`、`key`、`hold_key` 和 `wait`。
