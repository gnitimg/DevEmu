# 发布流程与代码签名

v1.0.0 起的正式发布流程。发布链路：GitHub Actions 构建（`.github/workflows/release.yml`）→ NSIS 安装包（首装可选安装目录，`installer/installer.nsi`）+ `checksums.txt` → draft release → 人工冒烟 → publish。

## 发布前冒烟旅程（打 tag 前逐项执行，勾完才准打 tag）

逐 diff 审查抓不住旅程级与规模级问题（v1.1.4 迁移冻结即漏网），以下每条都在
**打包后的安装版 + 真实量级数据**上跑一遍，任何一条不过不得发版：

1. 全新安装：选一个非默认安装目录 → 首启应弹使用说明 → 确认安装目录 `.data` 已生成
2. 覆盖安装：运行中先退出应用，安装器应装回原目录
3. 建一台虚拟机并启动 → 停止 → 再启动（配置与磁盘在重启后保留）
4. 导入一个真实体积 APK（≥100 MB）→ 导入即装 → 启动后自动补装
5. 数据迁移：存储页迁移到另一块盘的目标目录 → 圆环推进期间拖动/点击窗口应无"未响应" → 完成绿环打勾 → 重启后数据在新根
6. 应用内更新：旧版本点检查更新 → 下载（观察下载管理与侧栏胶囊同步）→ 完成弹"已就绪" → 立即安装并重启 → 版本号变更
7. 软件重置：重置并重启 → 回到首次安装状态

另跑 `npm run audit:sync-fs`（release.yml 已内置卡口）：主进程出现新的同步递归删除/同步复制即拦截。

## 发布日操作

1. **收尾合并**：功能分支收尾提交并合并回 `main`（发版永远从 `main` 打 tag）。
2. **版本定稿**：`package.json` 的 `version` 与 `assets/docs/changelog.md` 的 `## vX.Y.Z` 段放在**同一个提交**里（CI 从 changelog 抽取 release notes）。
3. **打 tag 发布**：
   ```
   git tag v1.0.0
   git push origin v1.0.0
   ```
   CI 自动跑 typecheck / test / `electron-forge make`，产物改名为固定资产名 `DevEmu-Setup-<version>.exe`（应用内更新按这个名字在 release 资产里匹配），生成 `checksums.txt`，创建 **draft release**。
4. **人工验收**：下载 draft 里的安装包，本机安装冒烟（安装、启动、覆盖安装各一次），确认无误后 publish release。
5. publish 后 `releases/latest` 即指向该版本，应用内"检查更新"立即生效。

> 也可以在 Actions 页手动触发（workflow_dispatch）做演练，但 draft 的 tag 会指向默认分支，正式发版请走 tag 推送。

## SignPath Foundation 代码签名

应用当前未签名，安装时会触发 SmartScreen 警告。签名方案选定 [SignPath Foundation](https://signpath.org)（为开源项目提供的免费 Authenticode 签名）。**申请与审批是人工步骤**，以下按阶段列出。

### 申请（人工）

1. 入口：<https://signpath.org/open-source>。
2. 条件：OSI 认可的开源协议（本仓库 MIT ✓）+ 公开发布的源码仓库（`gnitimg/DevEmu` ✓）+ 开发在公开平台进行。
3. 提交材料：项目名、仓库地址、项目简介、维护者联系方式。审批通常需要几天到几周。
4. 获批后会得到 SignPath Foundation 旗下的 organization（signpath.io 登录可见）。

### 激活（获批后）

1. **signpath.io 配置**：
   - 创建项目：slug `devemu`（与 release.yml 中 `project-slug` 一致）；
   - 创建 Artifact Configuration：slug `windows-setup`，布局定义"提交的包里所有 `.exe` 做 Authenticode 签名"（在控制台按官方文档配置）；
   - 创建 Signing Policy：slug `release-signing`，策略用 Foundation 提供的公开信任策略。
2. **GitHub secrets**（仓库 Settings → Secrets and variables → Actions）：
   - `SIGNPATH_API_TOKEN`：signpath.io 个人 API token；
   - `SIGNPATH_ORGANIZATION_ID`：organization 页面可见。
   配好即自动激活签名步骤，无需改 workflow（步骤按 secrets 是否存在条件执行）。
3. **核对 workflow**：对照官方 action 文档（[SignPath/github-action-submit-signing-request](https://github.com/SignPath/github-action-submit-signing-request)）确认 release.yml 中签名 step 的输入名与 artifact 布局匹配，首次签名后看 CI 日志与 `Get-AuthenticodeSignature` 断言。
4. **署名要求**：按 Foundation 条款在项目页注明签名来源，README 的"开源协议"处加一行"代码签名由 SignPath Foundation 提供"。

### 签名后必验（首个签名版本）

- 安装包属性中数字签名有效，发布者为 SignPath Foundation 名下的项目标识；
- 全新安装与**覆盖安装**各跑一次：NSIS 覆盖安装需先退出运行中的应用（安装器静默分支自带等待，人工覆盖安装请先手动退出），若覆盖安装报签名校验错误，备选方案是把包内主 exe 一并纳入 SignPath 签名布局，再评估；
- 覆盖安装成功后，用 v(n) 客户端演练一次 v(n+1) 的应用内更新闭环（检查 → 弹窗 → 下载 → 校验 → 安装重启）。

## 约定与注意

- **`checksums.txt` 是更新模块的完整性防线**：应用内更新下载后会校验 sha256，发布缺这个文件时更新会被拒绝。任何发布（含热修重发）都必须包含它。
- 安装包资产名必须保持 `DevEmu-Setup-<version>.exe`，不要在 GitHub 网页上手动改名或替换为其他命名。
- `releases/latest` 只取最新正式版，draft / prerelease 不影响应用内更新检查。
- 版本号比较是数值三元组（`0.2.10 > 0.2.9`），tag 用 `vX.Y.Z` 形式。
