# DevEmu

多系统虚拟机测试工作台。按项目组织虚拟机与 APK，一键安装测试。

当前支持 Android。架构预留了多系统适配位（`src/core` 为纯 Node，不依赖 Electron）。

## 两种模式

- **项目驱动**：每个项目独立的虚拟机、APK 库与测试记录，项目之间设备隔离（虚拟机文件按项目分目录存储）。
- **设备池**：公共设备，任意 APK 可安装测试，适合需要长期保留应用生态数据的场景。

## 环境要求

- Windows 10/11，已开启硬件虚拟化（BIOS VT-x/AMD-V，Windows 的 Hyper-V 或虚拟机平台）
- Android SDK（含 emulator、platform-tools；建议安装 cmdline-tools 与 build-tools）
- Java 17+（cmdline-tools 需要）

SDK 与 Java 会自动探测（ANDROID_HOME、`%LOCALAPPDATA%\Android\Sdk`、JAVA_HOME、Android Studio jbr），也可在设置页手动指定。系统镜像经官方 sdkmanager 渠道下载，首次下载需接受对应许可条款。

## 使用

```bash
npm install
npm start
```

常用脚本：

| 命令 | 说明 |
| --- | --- |
| `npm start` | 开发模式启动 |
| `npm test` | core 单元测试（node:test） |
| `npm run typecheck` | 类型检查 |
| `npm run package` | 打包 |
| `node scripts/e2e.ts` | 真实 SDK 端到端验证 |

流程：新建项目 → 新建虚拟机（选已装镜像或从 SDK 仓库下载）→ 启动 → 导入 APK → 测试（安装 + 启动 + 截图 + logcat 存档）→ 在测试记录里回看结果。

## 数据目录

默认 `%USERPROFILE%\DevEmu`，可在设置页修改：

```
DevEmu/
  settings.json          主配置（固定在此处）
  projects/<项目>/        项目模式：avd/ apps/ runs/ project.json
  devices/               设备池：avd/ apps/ runs/
```

项目隔离通过按作用域注入 `ANDROID_AVD_HOME` 实现；运行中的模拟器由系统 adb 统一管理，界面按作用域过滤展示。

## 分支

`main` 稳定版 · `develop` 集成 · `feature` 开发。
