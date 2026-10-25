# DevEmu Android MVP 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 交付可运行的 Electron 应用：两种模式（项目驱动 / 设备驱动）下创建、启动 Android 虚拟机并安装 APK 测试。

**Architecture:** 三层——renderer（React）→ main（Electron IPC 转发）→ core（纯 Node 服务）。隔离靠按作用域注入 `ANDROID_AVD_HOME`。

**Tech Stack:** Electron Forge + Vite + TypeScript + React；core 用 node:test 测试；不引 UI 组件库。

**执行方式：** 本会话内按任务顺序执行（Windows 本机环境依赖真实 SDK 验证，内联执行最可靠）。

---

### Task 1: 脚手架

**Files:** Create: package.json, forge.config.ts, vite.{main,preload,renderer}.config.ts, tsconfig.json, src/main.ts, src/preload.ts, src/renderer/{index.html,index.ts,App.tsx,app.css}

**Steps:**
1. 在 F:\cs\tmp-scaffold 用 `npx create-electron-app@latest tmp-scaffold --template=vite-typescript` 生成官方模板（保证版本组合已知可用）
2. 复制除 .git 外的文件到 F:\cs\DevEmu，合并 LICENSE/docs；删临时目录
3. 加 react/react-dom 与 @vitejs/plugin-react，renderer 改 .tsx；目录调整为 src/main.ts、src/preload.ts、src/renderer/、src/core/
4. `npm install`（必要时设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/）
5. `npm start` 验证窗口打开；`npm test`（node --test src/core）空跑通过
6. Commit: `chore: Electron Forge + Vite + React 脚手架`

### Task 2: core/env 路径与设置

**Files:** Create: src/core/env.ts, src/core/settings.ts; Test: src/core/settings.test.ts

- `getDataRoot()`：settings.json 里的 dataRoot，缺省 `%USERPROFILE%\DevEmu`
- settings 读写（JSON，原子写：tmp+rename）、目录确保（projects/、devices/avd、devices/apps）
- 测试：tmp 目录下 save→load 往返、缺省值、损坏文件回退默认
- Commit: `feat(core): 数据根与设置读写`

### Task 3: core/sdk 检测与镜像列表

**Files:** Create: src/core/sdk.ts; Test: src/core/sdk.test.ts

- `detectSdk()`：ANDROID_HOME → ANDROID_SDK_ROOT → %LOCALAPPDATA%\Android\Sdk → 常见路径；校验 emulator/、platform-tools/adb.exe 存在
- `detectJava()`：JAVA_HOME/bin → PATH → Android Studio jbr
- `listInstalledImages()`：扫 `system-images/android-<api>/<tag>/<abi>` 目录
- `parseSdkmanagerImages(stdout)`：解析 `sdkmanager --list` 的 Available Packages 段（fixture 驱动测试）
- `sdkmanagerList()` / `downloadImage(pkg)`：spawn java -jar sdkmanager，进度行透传
- Commit: `feat(core): SDK 检测与系统镜像管理`

### Task 4: core/avd 虚拟机管理

**Files:** Create: src/core/avd.ts; Test: src/core/avd.test.ts

- 作用域类型：`{ kind: 'project', projectId } | { kind: 'shared' }` → avdHome() 映射目录
- `parseAvdList(stdout)`：解析 `avdmanager list avd`（Name/Path/Based on，fixture 测试）
- `createAvd(scope, name, imagePkg, deviceDef)`：`avdmanager create avd` + env 注入
- `deleteAvd(scope, name)`；`listAvds(scope)`
- Commit: `feat(core): 按作用域的 AVD 管理`

### Task 5: core/emulator 启动与生命周期

**Files:** Create: src/core/emulator.ts; Test: src/core/emulator.test.ts（逻辑部分）

- `launch(scope, avdName)`：spawn `emulator -avd X -port <5554+2n>`，env 注入 ANDROID_AVD_HOME；登记 {avdName, port, pid}
- 存活跟踪：exit 事件更新注册表；`listRunning()`；`stop(serial)`：优先 `adb -s emu kill`，超时 kill pid
- 端口分配：5554 起偶数递增，避开已用
- Commit: `feat(core): 模拟器进程管理`

### Task 6: core/adb 设备操作

**Files:** Create: src/core/adb.ts; Test: src/core/adb.test.ts

- `parseDevices(stdout)`：`adb devices -l`（fixture 测试）
- `resolveAvdName(serial)`：`adb -s <serial> emu avd name`
- `install(serial, apkPath)`（-r -t）、`launchApp(serial, pkg, activity)`（am start）、`screenshot(serial)`（exec-out screencap -p → Buffer）
- `logcatTail(serial, cb)`：spawn 持续读行；`clearData`/`uninstall`
- 错误转译：常见 stderr → 中文提示（INSTALL_FAILED_UPDATE_INCOMPATIBLE 等）
- Commit: `feat(core): adb 操作与错误转译`

### Task 7: core/apk 导入与元数据

**Files:** Create: src/core/apk.ts; Test: src/core/apk.test.ts

- `parseBadging(stdout)`：aapt dump badging → package/versionName/launchable-activity/application-label（fixture 测试）
- `importApk(scope, srcPath)`：复制到 apps/，写 meta.json；aapt 缺失时降级（仅存文件，包名留空，安装后可由 dumpsys 补）
- Commit: `feat(core): APK 导入与解析`

### Task 8: core/projects 项目与测试记录

**Files:** Create: src/core/projects.ts, src/core/runs.ts; Test: src/core/projects.test.ts

- 项目 CRUD：project.json {id,name,note,createdAt}；列表按名排序
- runs：`runs/<yyyyMMdd-HHmmss>/` 存 screenshot.png、logcat.txt、result.json
- Commit: `feat(core): 项目与测试记录`

### Task 9: IPC 装配

**Files:** Create: src/ipc.ts；Modify: src/main.ts, src/preload.ts

- 通道：settings:get/save、sdk:detect/listImages/download、project:list/create/delete、avd:list/create/delete、emu:launch/list/stop、device:list（并串口状态）、apk:import/list/install/launch、test:screenshot/logcat/clear/uninstall、runs:record/list
- 全部返回 {ok, data|error}；preload contextBridge 暴露 `window.devemu`
- 手动验证：启动后 devtools console 调 `window.devemu.getSdk()`
- Commit: `feat: IPC 通道装配`

### Task 10: renderer UI

**Files:** Create: src/renderer/App.tsx, app.css, pages/{Projects,ProjectDetail,DevicePool,Settings}.tsx, components/{Modal,Empty,StatusDot,LogView}.tsx

- 布局：左侧 44px 图标导航（项目/设备池/设置）+ 内容区；顶栏只放当前页标题与主操作
- 项目页：项目列表（卡片）→ 项目详情 = 上半虚拟机行（名称/镜像/API/状态/操作）+ 下半 APK 表（名称/包名/版本/操作）；新建走 Modal
- 设备池页：同项目详情的虚拟机部分 + 公共 APK 库；任一运行中的公共设备可装任一 APK
- 设置页：SDK 路径（检测状态）、Java、数据根（改后重启生效）
- 视觉：浅色、13px、1px 边框 #e5e7eb、底 #f6f7f8、卡 #fff、单一强调色 #1f6feb、6px 圆角、无渐变无表情符；空状态一句话+按钮
- 状态轮询：adb devices 每 3s，映射到列表状态点
- 手动验证：走通建项目→建虚拟机→启动→状态变运行
- Commit: `feat(ui): 两种模式界面`

### Task 11: 端到端验证（真实 SDK）

1. 建 project demo → 下载/复用镜像 → 建 AVD → 启动至 boot completed
2. 导入任一测试 APK → 安装 → 启动 → 截图 → 记录 run → 停止
3. 设备模式重复装同一 APK 到公共设备
4. 修复发现的问题，每修一处一个 commit

### Task 12: 收尾

- README.md：是什么/装法/两模式说明/目录结构，短，无营销语
- `npm run package` 本地打包冒烟
- push feature；merge 到 develop 并 push；视验证情况 develop→main
- 汇报进度
