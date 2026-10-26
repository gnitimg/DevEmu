# DevEmu

多系统虚拟机测试工作台。按项目组织虚拟机与 APK，一键安装测试；提供设备池公共设备与 SDK 全生命周期管理。当前支持 Android；HarmonyOS 适配进行中（SDK 管理 / hdc 设备接入，见下文），架构已按多系统插件化预留（core 层为纯 Node，不依赖 Electron）。

## 功能

**两种工作模式**

- 项目驱动：每个项目独立的虚拟机、APK 库与测试记录，项目间设备隔离（虚拟机文件按项目分目录存储，注入 `ANDROID_AVD_HOME`）
- 设备池：公共设备，任意 APK 可安装测试；侧栏可下拉设备列表进入设备详情（信息 / 操作 / 测试记录）

**虚拟机管理**

- 新建：型号与系统均为级联双下拉（设备类型 → 机型；大版本 → 具体镜像），高级配置（内存 / 核数 / 数据分区）留空即用推荐值
- 启动：启动中 / 运行中状态实时显示；窗口自动移入屏幕可见区、禁止拉伸、多开级联排布；图形后端可配（软件渲染 / ANGLE / 宿主 GPU），黑屏可切换
- 关闭即强制关闭（优雅期后杀进程树）；应用重启后仍能通过 adb 兜底找到并关闭
- 已建虚拟机可编辑硬件配置（读取回显、按项修改）

**APK 测试**

- 导入 APK 自动解析包名 / 版本 / 入口 Activity（aapt；中文路径自动转 ASCII 暂存）
- 测试流程：选择运行中设备 → 仅安装 / 安装并启动；自动截图与 logcat 存档，测试记录（通过 / 安装失败 / 启动失败）按项目或设备池归档

**SDK 管理**

- 组件管理：已安装列表本地秒读、可安装列表联网懒加载，安装 / 卸载带实时进度行
- 镜像管理：设置页直接列出已装镜像并可删除
- 下载线路：直连 / 本地代理自动测速（延迟 + 丢包，各 4 采样），自动选择
- 下载管理：独立界面显示下载中 / 已下载；进度条内嵌实时速度（1 秒窗口字节差真实计算）、已下载 / 总大小、剩余时间 = 剩余大小 / 实时速度；支持取消
- 下载与限速：最高下载速度（无限制可选）经本地整形代理按令牌桶真实限速；并行下载数 1-4，超出的任务排队自动接力

**设备网络**

- 设备代理：启用后模拟器网络走 `http://127.0.0.1:<端口>`（默认 7890）

**Agent 接入**

- 内置本机控制桥（仅监听 127.0.0.1，Bearer 令牌鉴权），把在线虚拟设备的截图、点击、滑动、文本输入、按键、shell、界面控件树暴露为 HTTP API
- 附带零依赖 MCP stdio 桥（`resources/agent-mcp.mjs`），ZCode / Codex CLI 等支持 MCP 的 AI 工具以 `node` 一行配置接入，即可像操作电脑一样自主操作虚拟 Android / HarmonyOS 设备
- 设置 → Agent 接入：开关、端口、令牌管理，一键复制接入配置；详见 [docs/agent-bridge.md](docs/agent-bridge.md)

**HarmonyOS（适配中）**

- SDK 管理页右上角可切换 Android / HarmonyOS
- 自动探测 DevEco Studio 安装（`DEVECO_HOME`、`C:\Program Files\Huawei\DevEco Studio*`）与 SDK（`DEVECO_SDK_HOME`、`HOS_SDK_HOME`、`%LOCALAPPDATA%\Huawei\Sdk`），支持 default 与版本号两种目录布局；也可在设置中浏览指定
- 展示 hdc 路径、SDK 版本（uni-package.json）、openharmony / hms 组件清单，并可经 `hdc list targets` 查询在线设备

## 环境要求

- Windows 10/11，已开启硬件虚拟化（BIOS VT-x/AMD-V + Hyper-V 或虚拟机平台）
- Android SDK（emulator、platform-tools；建议 cmdline-tools 与 build-tools），Java 17+
- SDK 与 Java 自动探测（ANDROID_HOME、`%LOCALAPPDATA%\Android\Sdk`、JAVA_HOME、Android Studio jbr），路径在设置中回填并可浏览修改
- 系统镜像经官方 sdkmanager 渠道下载，许可由用户在 Android Studio 中接受

## 使用

```bash
npm install
npm start
```

| 命令 | 说明 |
| --- | --- |
| `npm start` | 开发模式启动 |
| `npm test` | core 单元测试（node:test） |
| `npm run typecheck` | 类型检查 |
| `npm run package` | 打包（输出 out/DevEmu-win32-x64） |
| `node scripts/e2e.ts` | 真实 SDK 端到端验证（建项目 → 建机 → 启动 → 导入 → 安装 → 启动 → 截图 → 记录 → 关闭） |

## 架构

```
src/
  main.ts        Electron 主进程：窗口与 IPC 装配
  preload.ts     contextBridge 暴露 window.devemu（无 Node 集成，渲染层隔离）
  ipc.ts         通道层：参数校验、进度/下载快照广播
  core/          纯 Node 业务层（可被 CLI 复用）
    exec.ts        子进程封装（bat→java 直调、二进制安全输出）
    settings.ts    设置读写（原子写、固定主配置位置）
    env.ts         作用域目录（项目隔离的关键）
    sdk.ts         SDK/Java 探测、镜像扫描、sdkmanager 封装
    avd.ts         AVD 创建/删除/硬件配置/残留清理
    emulator.ts    进程生命周期、端口探测、参数组装
    adb.ts         设备/安装/启动/截图/logcat、错误中文化
    apk.ts         APK 导入与 badging 解析
    projects.ts    项目 CRUD
    runs.ts        测试记录归档
    downloads.ts   下载管理器（解析、速度/ETA、并行队列、取消）
    throttle.ts    本地整形代理（令牌桶限速、CONNECT 隧道）
    net.ts         下载线路测速
    harmony.ts     HarmonyOS 环境探测（DevEco/SDK/hdc）与设备列表
    agent.ts       Agent 控制桥：本机 HTTP 服务（鉴权、路由、桥生命周期）
    agentOps.ts    控制桥设备操作实现（adb input/uiautomator、hdc uitest/snapshot）
    win.ts         窗口重定位/禁拉伸/兜底强杀（Win32）
  renderer/     React 界面（侧栏工作目录 + 各页面）
resources/
  agent-mcp.mjs   MCP stdio 桥（零依赖，落盘到数据目录供 `node` 启动）
```

数据目录（默认 `%USERPROFILE%\DevEmu`，设置页可改）：

```
DevEmu/
  settings.json          主配置
  projects/<项目>/        avd/ apps/ runs/ project.json
  devices/               avd/ apps/ runs/（设备池）
```

## 安全说明

- 渲染层无 Node 集成，全部能力经 contextBridge 暴露的白名单 IPC 通道
- IPC 入参做类型与格式校验（作用域 projectId 拒绝路径字符、包名白名单正则）
- 不收集任何数据；代理与限速仅在本机环回端口工作

## 分支

`main` 稳定版 · `develop` 集成 · `feature` 开发。
