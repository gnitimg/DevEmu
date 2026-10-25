# DevEmu Android MVP 设计

日期：2026-10-25
分支：feature

## 目标

DevEmu 是一个多系统虚拟机测试工作台。MVP 只做 Android：下载/复用系统镜像、创建虚拟机、导入 APK、安装到虚拟机运行测试。核心概念是两种使用模式：

- **项目驱动模式**：每个项目一个文件夹，虚拟机、APK、测试记录归属项目，项目间设备隔离。
- **设备驱动模式**：直接创建公共设备，按需安装任意 APK，适合有生态需求的应用。

## 非目标（MVP 不做）

- 鸿蒙 / iOS 支持（架构预留插件位，不实现）
- 源码构建（只支持导入已构建的 APK）
- UI 自动化测试、性能采集
- 模拟器镜像自建与分发（一律走官方 sdkmanager 渠道）

## 技术栈

- Electron Forge + Vite + TypeScript + React（渲染层）
- core 为纯 Node 模块，不依赖 Electron，后续可被 CLI 复用
- 单元测试用 node:test，零额外依赖
- UI 手写 CSS，不引组件库

## 架构

```
renderer/   React 界面（IPC 调用，不直接碰 Node API）
main/       Electron 主进程：窗口、IPC 转发、core 装配
core/       纯 Node 业务模块
  SdkService      SDK 检测、sdkmanager 包装（列镜像/下载）
  ProjectService  项目与数据根的文件模型
  AvdService      avdmanager 包装，按作用域创建/删除虚拟机
  EmulatorService spawn emulator 进程，跟踪存活
  AdbService      adb 包装：设备列表、安装、启动、截图、logcat
  ApkService      APK 导入与 aapt 元数据解析
```

## 数据模型

```
<数据根>/                  默认 %USERPROFILE%\DevEmu，首启可选
  settings.json            sdkPath、javaPath、dataRoot
  projects/<项目>/
    project.json
    avd/                   ANDROID_AVD_HOME 指向此处 → 项目隔离
    apps/                  导入的 APK 副本 + meta.json
    runs/<时间戳>/          截图、logcat 快照、result.json
  devices/
    avd/                   设备驱动模式的公共设备池
    apps/
```

隔离机制：创建/启动虚拟机时注入 `ANDROID_AVD_HOME` 指向对应作用域目录。adb 层面运行中的模拟器仍由同一 adb server 管理（Android 机制），UI 按作用域过滤展示。

## SDK 策略

优先复用本机已有 SDK（默认探测 `%LOCALAPPDATA%\Android\Sdk`、ANDROID_HOME），路径可改；无 SDK 时引导经官方 sdkmanager 下载 commandline-tools 与系统镜像，许可证由用户确认。Java 自动探测 JAVA_HOME / PATH / Android Studio jbr。

## 核心流程

1. 建虚拟机：列出已装系统镜像（可下载）→ 选机型 → avdmanager create 到作用域
2. 启动：spawn emulator -avd <name>（作用域 env），跟踪进程
3. 导入 APK：复制进 apps/，aapt 解析包名/版本/入口 Activity
4. 测试：adb install → 启动 → 截图 / logcat / 清数据 / 卸载
5. 记录：runs/<时间戳>/ 存截图与日志

## UI 原则

- 克制：无营销文案、无欢迎页、无表情符号、无渐变堆砌；空状态只给一句可操作的话
- 信息密度优先，中文文案精确短句
- 布局：左侧栏（项目 / 设备池 / 设置）；项目页上半虚拟机卡片、下半 APK 列表；详情区显示状态、截图、日志

## 错误处理

Java 缺失、虚拟化未开启（emulator 报错转译为中文对策）、端口占用、SDK 路径失效：检测并在 UI 提示。

## 测试

- core 的命令输出解析（sdkmanager list、aapt badging、adb devices）写单元测试
- 端到端用本机真实 SDK 手动验证：建项目 → 建虚拟机 → 启动 → 导入 APK → 安装 → 截图 → 记录

## 分支流程

feature 分支开发；阶段里程碑合入 develop；验证完整后 develop → main。每次停止工作前必须推送并汇报进度。
