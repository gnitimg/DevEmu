import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.ts';
import { downloadToString, type DlOptions } from './net.ts';

/**
 * 环境安装：设置页浏览目录未检测到环境时，可从官方源下载安装包并解压到所选目录。
 *
 * - Android SDK：Google 官方 commandline-tools 最新构建（repository2-3.xml 解析，失败退回已知版本）。
 *   装好后由 ipc 层继续用 sdkmanager 链式安装 platform-tools 与 emulator（许可经 --licenses 自动接受）。
 * - Java：Adoptium Temurin 最新 JDK LTS（API 动态解析 GitHub 直链）。
 * - HarmonyOS SDK：华为要求登录开发者账号后才能从官方下载中心获取直链（签名时效 URL），无匿名官方源，
 *   只能引导用户打开官方下载页手动下载。
 */

export type EnvKind = 'android' | 'harmonyos' | 'java';

export const ENV_LABELS: Record<EnvKind, string> = {
  android: 'Android SDK',
  harmonyos: 'HarmonyOS SDK',
  java: 'Java 运行环境',
};

/** 华为命令行工具官方下载页（需登录华为账号） */
export const HARMONY_MANUAL_URL = 'https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos';

/** Android commandline-tools 兜底版本（官方清单拉取失败时使用；2026-10 验证可达） */
const ANDROID_CMDTOOLS_FALLBACK = { build: 16111833, file: 'commandlinetools-win-16111833_latest.zip' };

/** 当前官方最新 JDK LTS 大版本（2027-09 Java 29 LTS 发布后更新此值） */
const JAVA_LTS_FEATURE = 25;

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 目录内是否已有对应环境的痕迹（任一标志即算，避免误弹安装提示） */
export function checkEnvDir(kind: EnvKind, dir: string): boolean {
  if (!dir || !exists(dir)) return true; // 目录不存在交给后续流程报错，不弹安装提示
  if (kind === 'android') {
    return [
      path.join(dir, 'platform-tools', 'adb.exe'),
      path.join(dir, 'emulator', 'emulator.exe'),
      path.join(dir, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat'),
      path.join(dir, 'build-tools'),
      path.join(dir, 'platforms'),
    ].some(exists);
  }
  if (kind === 'harmonyos') {
    return [
      path.join(dir, 'openharmony', 'toolchains'),
      path.join(dir, 'default', 'openharmony', 'toolchains'),
      path.join(dir, 'commandline-tools'),
    ].some(exists);
  }
  // java：bin/java.exe、<子目录>/bin/java.exe、<子目录>/jbr/bin/java.exe
  const cands = [path.join(dir, 'java.exe'), path.join(dir, 'bin', 'java.exe')];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      cands.push(path.join(dir, e.name, 'bin', 'java.exe'), path.join(dir, e.name, 'jbr', 'bin', 'java.exe'));
    }
  } catch {
    // 目录不可读：按未找到处理
  }
  return cands.some(exists);
}

/** 一份环境安装计划：官方源地址与展示信息 */
export interface EnvPlan {
  /** 下载任务标识 */
  key: string;
  /** 下载管理显示名 */
  desc: string;
  host: string;
  path: string;
  fileName: string;
}

/** 解析某环境的官方最新安装包（发请求取版本清单，可能耗时数秒） */
export async function resolveEnvPlan(kind: EnvKind, dl: DlOptions): Promise<EnvPlan> {
  if (kind === 'android') {
    try {
      const xml = await downloadToString({ host: 'dl.google.com', path: '/android/repository/repository2-3.xml' }, dl);
      const builds = [...xml.matchAll(/commandlinetools-win-(\d+)_latest\.zip/g)]
        .map((m) => parseInt(m[1]!, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      const build = builds.length ? Math.max(...builds) : ANDROID_CMDTOOLS_FALLBACK.build;
      const fileName = `commandlinetools-win-${build}_latest.zip`;
      return {
        key: `commandlinetools-${build}`,
        desc: 'Android 命令行工具',
        host: 'dl.google.com',
        path: `/android/repository/${fileName}`,
        fileName,
      };
    } catch {
      // 清单拉不到（离线/网络受限）：退回已知版本的固定直链
      return {
        key: `commandlinetools-${ANDROID_CMDTOOLS_FALLBACK.build}`,
        desc: 'Android 命令行工具',
        host: 'dl.google.com',
        path: `/android/repository/${ANDROID_CMDTOOLS_FALLBACK.file}`,
        fileName: ANDROID_CMDTOOLS_FALLBACK.file,
      };
    }
  }
  if (kind === 'java') {
    const raw = await downloadToString(
      {
        host: 'api.adoptium.net',
        path: `/v3/assets/latest/${JAVA_LTS_FEATURE}/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse`,
      },
      dl,
    );
    const list = JSON.parse(raw) as Array<{ release_name?: string; binary?: { package?: { link?: string } } }>;
    const link = list[0]?.binary?.package?.link;
    if (!link) throw new Error('未能解析 Temurin 最新版下载地址');
    const u = new URL(link);
    if (u.protocol !== 'https:') throw new Error('下载地址非 https，已中止');
    const fileName = decodeURIComponent(u.pathname.split('/').pop() ?? 'jdk.zip');
    const ver = (list[0].release_name ?? fileName).replace(/^jdk-/i, '');
    return {
      key: `temurin-jdk-${ver}`,
      desc: `Java ${ver}（Temurin LTS）`,
      host: u.host,
      path: u.pathname + u.search,
      fileName,
    };
  }
  throw new Error('HarmonyOS SDK 需登录华为开发者账号后从官方下载');
}

/** 用系统自带 bsdtar 解压 zip（Windows 10 1803+ 自带 tar.exe） */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  let res;
  try {
    res = await run('tar.exe', ['-xf', zipPath, '-C', destDir]);
  } catch {
    throw new Error('解压失败：系统缺少 tar.exe（Windows 10 1803+ 自带）');
  }
  if (res.code !== 0) {
    throw new Error(`解压失败：${(res.stderr || res.stdout).trim().slice(0, 200) || `退出码 ${res.code}`}`);
  }
}

/** Android：解压 commandline-tools 并落位到 <dir>/cmdline-tools/latest（已存在则幂等跳过） */
export async function installAndroidCmdtools(zipPath: string, dir: string, setPct: (p: number) => void): Promise<void> {
  if (exists(path.join(dir, 'cmdline-tools', 'latest', 'bin'))) {
    setPct(50); // 之前装过：直接进入链式补装
    return;
  }
  const staging = path.join(dir, `.devemu-staging-${Date.now()}`);
  try {
    await extractZip(zipPath, staging);
    setPct(60);
    const extracted = path.join(staging, 'cmdline-tools');
    if (!exists(path.join(extracted, 'bin'))) {
      throw new Error('压缩包结构不符合预期（缺少 cmdline-tools/bin）');
    }
    fs.mkdirSync(path.join(dir, 'cmdline-tools'), { recursive: true });
    fs.renameSync(extracted, path.join(dir, 'cmdline-tools', 'latest'));
    setPct(95);
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // 清理失败忽略
    }
  }
}

/** Java：解压 JDK 到 <dir>/jdk-<版本>/，返回其中的 java.exe 路径 */
export async function installJdk(zipPath: string, dir: string, setPct: (p: number) => void): Promise<string> {
  const staging = path.join(dir, `.devemu-staging-${Date.now()}`);
  try {
    await extractZip(zipPath, staging);
    setPct(70);
    const tops = fs
      .readdirSync(staging, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const top = tops[0];
    if (!top || !exists(path.join(staging, top.name, 'bin', 'java.exe'))) {
      throw new Error('压缩包结构不符合预期（缺少 bin/java.exe）');
    }
    let dest = path.join(dir, top.name);
    let n = 2;
    while (exists(dest)) dest = path.join(dir, `${top.name}-${n++}`);
    fs.renameSync(path.join(staging, top.name), dest);
    setPct(95);
    return path.join(dest, 'bin', 'java.exe');
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // 清理失败忽略
    }
  }
}
