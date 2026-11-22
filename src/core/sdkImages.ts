import fs from 'node:fs';
import path from 'node:path';
import { moveInto } from './settings.ts';

/** Android 系统镜像在 SDK 根下的固定目录名（sdkmanager 约定，不可改） */
const IMAGES_DIR = 'system-images';

export interface EnsureImagesRootResult {
  ok: boolean;
  error?: string;
  /** 本次实际搬进数据根的字节数；仅建链/识别跳过时为 0 */
  movedBytes: number;
}

export interface EnsureImagesRootOpts {
  /** qemu 持有镜像句柄，运行中不搬移（跨卷删除必失败），等下次调用点重试 */
  emulatorsRunning: boolean;
}

function imagesTarget(dataRoot: string): string {
  return path.join(dataRoot, 'sdk', IMAGES_DIR);
}

function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isJunctionTo(linkPath: string, target: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(linkPath);
  } catch {
    return false;
  }
  if (!st.isSymbolicLink()) return false;
  try {
    // junction 的 readlink 返回创建时写入的目标字面量，resolve 消除盘符大小写与尾部斜杠差异
    return samePath(fs.readlinkSync(linkPath), target);
  } catch {
    return false;
  }
}

function createImagesLink(linkPath: string, target: string): void {
  // junction（win32）免管理员且要求目标为绝对路径；其余平台用目录符号链接
  fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * 只摘除 reparse point 本身：rmdirSync 对 junction/空目录均适用；
 * 绝不能用 recursive 删除——会穿透链接把数据根里的真实镜像删掉
 */
function removeImagesDir(linkPath: string): void {
  fs.rmdirSync(linkPath);
}

async function ensureImagesRoot(
  sdkPath: string,
  dataRoot: string,
  opts: EnsureImagesRootOpts,
): Promise<EnsureImagesRootResult> {
  if (!sdkPath || !dataRoot) return { ok: true, movedBytes: 0 };
  const sdkRoot = path.resolve(sdkPath);
  const root = path.resolve(dataRoot);
  // SDK 本身已放在数据根内：sdkmanager 直接落数据根，无需重定向
  if (isInside(root, sdkRoot)) return { ok: true, movedBytes: 0 };
  const linkPath = path.join(sdkRoot, IMAGES_DIR);
  const target = imagesTarget(root);
  let movedBytes = 0;
  try {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(linkPath);
    } catch {
      // 不存在：SDK 未装镜像或首次对齐
    }
    if (st?.isSymbolicLink()) {
      if (isJunctionTo(linkPath, target)) return { ok: true, movedBytes: 0 };
      // 数据根迁移过：旧 link 指向旧根，镜像内容已在数据根，只重建链接
      removeImagesDir(linkPath);
    } else if (st?.isDirectory()) {
      if (fs.readdirSync(linkPath).length > 0) {
        if (opts.emulatorsRunning)
          return {
            ok: false,
            error: '有虚拟机正在运行，请先全部关闭后再重试',
            movedBytes: 0,
          };
        // 旧镜像（可能几个 GB）搬进数据根；moveInto 合并语义保证目标已有
        // 内容（上次中断的残局）时以源为准补齐
        await moveInto(linkPath, target, (n) => {
          movedBytes += n;
        });
        // rm 被占用打断时 moveInto 已抛错走不到这里；仍存在说明清源有残缺，
        // 保持旧布局不动（镜像两处各有部分），下次对齐继续补
        if (fs.existsSync(linkPath))
          return {
            ok: false,
            error: '镜像源目录清理未完成（可能被占用）',
            movedBytes,
          };
      } else {
        removeImagesDir(linkPath);
      }
    } else if (st) {
      return { ok: false, error: `${IMAGES_DIR} 位置被同名文件占用`, movedBytes: 0 };
    }
    fs.mkdirSync(target, { recursive: true });
    createImagesLink(linkPath, target);
    return { ok: true, movedBytes };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      movedBytes,
    };
  }
}

let inFlight: Promise<EnsureImagesRootResult> | null = null;

/**
 * 幂等对齐：镜像落位数据根 `<dataRoot>\sdk\system-images`，SDK 根下保留
 * junction，sdkmanager 写入、emulator 解析 image.sysdir.1、镜像扫描三方
 * 全部无感知。并发调用复用在飞任务，避免「搬移进行中 sdkmanager 在旧位置
 * 建出真实目录」的竞态；失败不建链，旧布局继续可用，等待下次调用点重试。
 */
export function ensureAndroidImagesRoot(
  sdkPath: string | undefined,
  dataRoot: string,
  opts: EnsureImagesRootOpts,
): Promise<EnsureImagesRootResult> {
  if (inFlight) return inFlight;
  inFlight = ensureImagesRoot(sdkPath ?? '', dataRoot, opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
