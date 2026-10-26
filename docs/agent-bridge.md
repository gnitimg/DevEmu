# Agent 控制桥

让本机 AI 编程工具（ZCode、Codex CLI 等支持 MCP 的 agent）像控制电脑/浏览器一样，自主操作 DevEmu 里的虚拟 Android / HarmonyOS 设备：看屏幕（截图）、点按、滑动、输入文字、按键、执行 shell、读取界面控件树，以及启动/关闭虚拟机。

## 组成

```
AI agent（ZCode / Codex CLI）
   │  MCP stdio（JSON-RPC 按行分帧）
   ▼
resources/agent-mcp.mjs        零依赖 MCP 桥（落到 <数据根>\agent\agent-mcp.mjs 运行）
   │  HTTP（Bearer 令牌）
   ▼
DevEmu 控制桥 core/agent.ts    仅监听 127.0.0.1，路由/鉴权/参数校验
   │
   ▼
core/agentOps.ts               adb（input / uiautomator / screencap）
                               hdc（uitest / snapshot_display）
```

- 控制桥随 DevEmu 启动按设置自动拉起；开关、端口、令牌在 **设置 → Agent 接入** 管理。
- MCP 桥脚本由 DevEmu 自动复制到数据目录（打包版脚本在 asar 内，外部 `node` 进程读不到，必须落盘）。
- MCP 桥需要本机安装 Node.js（≥ 18，fetch 内置）。

## 接入 ZCode / Codex

设置 → Agent 接入 → 启用，复制生成的配置片段，加入对应客户端的 MCP 配置：

```json
{
  "mcpServers": {
    "devemu": {
      "command": "node",
      "args": ["C:\\Users\\<你>\\DevEmu\\agent\\agent-mcp.mjs"],
      "env": { "DEVEMU_AGENT": "http://127.0.0.1:7531", "DEVEMU_TOKEN": "<你的令牌>" }
    }
  }
}
```

之后 agent 即可获得这些工具（多数操作在只有一台设备在线时可省略 `device` 参数）：

| 工具 | 说明 |
| --- | --- |
| `device_list` | 在线设备列表（Android 模拟器 + HarmonyOS 设备） |
| `device_screenshot` | 截图，返回图片（供视觉模型观察界面） |
| `device_tap` | 点击坐标 (x, y) |
| `device_swipe` | 滑动 (x1,y1)→(x2,y2)，可选 `durationMs`（默认 300） |
| `device_text` | 向焦点输入框输入文本（建议先点中输入框；Android 暂不支持中文） |
| `device_key` | 按键：home/back/enter/delete/menu/volume_up/volume_down/power/recents（Android 另支持数字键值） |
| `device_shell` | 设备 shell（如 `pm list packages`、`dumpsys window`） |
| `device_ui` | 界面控件树（Android 为 uiautomator XML；HarmonyOS 为 uitest JSON），用于定位控件坐标 |
| `emulator_launch` | 启动虚拟机（`scope`：`shared` 或 `project:<id>`，缺省 shared） |
| `emulator_stop` | 关闭虚拟机 |

典型用法：让 agent「在 XX 设备上打开设置 → 截图确认 → 滑到关于手机 → 截图」，或「安装后启动应用，操作几步，读 logcat 报错」——agent 自行用截图 + 控件树闭环。

## HTTP API（直连）

不想走 MCP 时也可直接 HTTP 调用（如自己的脚本）：所有请求需带头 `Authorization: Bearer <令牌>`；`Content-Type: application/json`。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health` | 存活检查（无需令牌） |
| `GET /api/devices` | 设备列表 `[{serial, type, state, avdName?}]` |
| `GET /api/device/:serial/screenshot` | PNG（Android）/ JPEG（HarmonyOS）二进制 |
| `GET /api/device/:serial/ui` | `{format: 'xml'\|'json', content}` |
| `POST /api/device/:serial/tap` | `{x, y}` |
| `POST /api/device/:serial/swipe` | `{x1, y1, x2, y2, durationMs?}` |
| `POST /api/device/:serial/text` | `{text, x?, y?}`（x/y 仅 HarmonyOS 输入点位） |
| `POST /api/device/:serial/key` | `{key}` |
| `POST /api/device/:serial/shell` | `{command}` → `{code, stdout, stderr}` |
| `POST /api/emulator/launch` | `{avdName, scope?}` → `{serial}` |
| `POST /api/emulator/stop` | `{avdName, scope?}` |

`:serial` 支持设备 serial，也可用 AVD 名（同名多台时须用 serial）。作用域 `scope` 形如 `shared` 或 `project:<projectId>`。

示例：

```bash
curl -H "Authorization: Bearer <令牌>" http://127.0.0.1:7531/api/devices
curl -H "Authorization: Bearer <令牌>" -o shot.png http://127.0.0.1:7531/api/device/emulator-5554/screenshot
curl -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" ^
     -d "{\"x\":540,\"y\":1200}" http://127.0.0.1:7531/api/device/emulator-5554/tap
```

## 安全

- 仅监听 `127.0.0.1`，外部机器不可达
- 除 health 外全部要求 Bearer 令牌；令牌保存在 `%USERPROFILE%\DevEmu\settings.json`，可在设置页随时换发
- 携带 `Origin` 头的请求一律 403——浏览器网页无法借用户的浏览器会话打洞（CSRF 无法伪造自定义头）
- `shell` 等同设备调试权限（与 adb 相同信任级别），请勿把令牌交给不受信任的客户端

## 已知限制

- Android `input text` 不接受中文等非 ASCII 字符（系统限制）；HarmonyOS 经 `uitest uiInput inputText` 无此限制
- HarmonyOS 界面树 / 截图依赖 `uitest dumpLayout` / `snapshot_display`（OpenHarmony 设备均内置）
- 暂无屏幕实时串流；agent 以「截图 → 操作 → 再截图」循环闭环
- DevEco 模拟器的创建/启动仍需在 DevEco Studio 中完成；本桥可操作已在线的 HarmonyOS 设备
