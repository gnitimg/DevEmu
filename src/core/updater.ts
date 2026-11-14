import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import {
  downloadToFile,
  downloadToString,
  type DlOptions,
  type DlTarget,
} from './net.ts';

export const GITHUB_REPO = 'gnitimg/DevEmu';
/** 更新包资产与校验文件的固定资产名，由发布 CI 保证；updater 按名字匹配 */
export const CHECKSUMS_ASSET = 'checksums.txt';
export function setupAssetName(version: string): string {
  return `DevEmu-Setup-${version}.exe`;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface ReleaseInfo {
  /** tag 去掉 v 前缀后的版本号 */
  version: string;
  notes: string;
  htmlUrl: string;
  setupAsset: ReleaseAsset | null;
  checksumsAsset: ReleaseAsset | null;
}

/** 解析 vX.Y.Z(-后缀) 形式的版本号；缺段按 0 处理（v1.0 等于 v1.0.0），不可解析返回 null */
export function parseVersion(tag: string): [number, number, number] | null {
  const m = tag.replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** a>b 返回 1，a<b 返回 -1，相等返回 0；数字段一致时带 -后缀（预发布）的一方更新 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  }
  const preA = a.includes('-');
  const preB = b.includes('-');
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}

/** 按固定资产名匹配 Setup 安装包；找不到时回退到任意 DevEmu*Setup*.exe，容忍命名漂移 */
export function pickSetupAsset(
  assets: ReleaseAsset[],
  version: string,
): ReleaseAsset | null {
  const exact = assets.find(
    (a) => a.name.toLowerCase() === setupAssetName(version).toLowerCase(),
  );
  if (exact) return exact;
  return assets.find((a) => /^devemu.*setup.*\.exe$/i.test(a.name)) ?? null;
}

export function pickChecksumsAsset(
  assets: ReleaseAsset[],
): ReleaseAsset | null {
  return assets.find((a) => a.name.toLowerCase() === CHECKSUMS_ASSET) ?? null;
}

interface GithubRelease {
  tag_name?: string;
  body?: string;
  html_url?: string;
  assets?: { name?: string; browser_download_url?: string; size?: number }[];
}

/** 拉取最新正式版（GitHub API 自动跳过 draft/prerelease）；失败抛出带用户可读信息的 Error */
export async function fetchLatestRelease(): Promise<ReleaseInfo> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: { 'User-Agent': 'DevEmu' },
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch {
    throw new Error('检查更新失败（无法访问 GitHub）');
  }
  if (res.status === 404) throw new Error('仓库暂无发布版本');
  if (!res.ok) throw new Error(`检查更新失败（HTTP ${res.status}）`);
  const j = (await res.json().catch(() => null)) as GithubRelease | null;
  const tag = j?.tag_name;
  if (!tag) throw new Error('未获取到发布信息');
  const assets: ReleaseAsset[] = (j.assets ?? [])
    .filter((a) => a.name && a.browser_download_url)
    .map((a) => ({
      name: a.name!,
      url: a.browser_download_url!,
      size: a.size ?? 0,
    }));
  const version = tag.replace(/^v/, '');
  return {
    version,
    notes: j.body ?? '',
    htmlUrl: j.html_url ?? `https://github.com/${GITHUB_REPO}/releases`,
    setupAsset: pickSetupAsset(assets, version),
    checksumsAsset: pickChecksumsAsset(assets),
  };
}

export function targetFromUrl(url: string): DlTarget | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return { host: u.host, path: u.pathname + u.search };
  } catch {
    return null;
  }
}

export function updateDir(): string {
  return path.join(os.tmpdir(), 'DevEmu-update');
}

/** sha256sum 风格文本（`<hex>  <文件名>`）解析为映射，键为文件名小写 */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
    if (m) map.set(m[2]!.toLowerCase(), m[1]!.toLowerCase());
  }
  return map;
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * 校验下载的安装包；发布未提供 checksums.txt 或文件不在清单里时视为失败
 * （应用未代码签名前，这是更新包的主要完整性防线，宁严勿松）
 */
export async function verifyChecksum(
  exePath: string,
  checksumsText: string,
): Promise<void> {
  const expect = parseChecksums(checksumsText).get(
    path.basename(exePath).toLowerCase(),
  );
  if (!expect) throw new Error('发布未提供该安装包的校验值，已阻止安装');
  const actual = await sha256File(exePath);
  if (actual !== expect)
    throw new Error('安装包校验失败（sha256 不匹配），已阻止安装');
}

let cancelled = false;

export function cancelUpdateDownload(): void {
  cancelled = true;
}

export interface DownloadUpdateOptions {
  viaProxy?: boolean;
  proxyPort?: number;
  /** 字节/秒上限，来自设置的“最高下载速度” */
  maxBps?: number;
  onProgress?: (received: number, total: number) => void;
}

/**
 * 下载最新版安装包到临时目录并完成 sha256 校验，返回安装包路径。
 * 目录先清空：残留的旧版安装包没有保留价值，还占双倍空间。
 */
export async function downloadUpdate(
  release: ReleaseInfo,
  opts: DownloadUpdateOptions = {},
): Promise<string> {
  if (!release.setupAsset) throw new Error('发布中缺少安装包，无法自动更新');
  if (!release.checksumsAsset)
    throw new Error('发布中缺少校验文件，无法自动更新');
  const exeTarget = targetFromUrl(release.setupAsset.url);
  const sumTarget = targetFromUrl(release.checksumsAsset.url);
  if (!exeTarget || !sumTarget) throw new Error('安装包下载地址无效');

  cancelled = false;
  const dir = updateDir();
  fs.rmSync(dir, {
    // sync-ok: 更新目录仅含单个安装包与校验文件，unlink 为元数据级操作
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 300,
  });
  fs.mkdirSync(dir, { recursive: true });
  const exePath = path.join(dir, release.setupAsset.name);

  const dlOpts: DlOptions = {
    viaProxy: opts.viaProxy,
    proxyPort: opts.proxyPort,
    maxBps: opts.maxBps,
    onProgress: opts.onProgress,
    isCancelled: () => cancelled,
  };
  await downloadToFile(exeTarget, exePath, dlOpts);
  // 校验文件与安装包走同一发布源，在校验文件本身被篡改的场景下
  // 两者一致并不能证明安全；它防的是传输损坏与发布替换不同步
  const sums = await downloadToString(sumTarget, {
    viaProxy: opts.viaProxy,
    proxyPort: opts.proxyPort,
    isCancelled: () => cancelled,
  });
  await verifyChecksum(exePath, sums);
  return exePath;
}

/**
 * 运行 NSIS 安装包完成更新：/S 静默安装（installer.nsi 会回读注册表里的既有
 * 安装目录），覆盖完成后自动重启应用；旧实例由调用方在启动安装器后退出。
 * spawn 被 AV/ACL 拒绝（EACCES）时抛错，由调用方走 ShellExecute 兜底——
 * 此前失败静默成未捕获异常，应用照常退出，用户只看到“更新了但版本没变”。
 */
export function spawnInstaller(exePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, ['/S'], {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(exePath),
    });
    // spawn 与 error 二选一先到：不挂 error 监听会把 EACCES 变成未捕获异常
    child.once('spawn', () => resolve());
    child.once('error', (e) => reject(e));
  });
}
