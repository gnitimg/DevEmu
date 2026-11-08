import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserWindow,
  session,
  type DownloadItem,
  type WebContents,
} from 'electron';
import { adoptExternalDownload, startFileDownload } from './downloads.ts';
import { importCommandlineTools } from './harmony.ts';
import { HARMONY_MANUAL_URL } from './envinstall.ts';
import {
  HUAWEI_PARTITION,
  hasHuaweiLogin,
  requestHuaweiLogin,
} from './huawei.ts';

/**
 * 华为命令行工具下载：用已登录的 persist:huawei 会话在隐藏窗口里打开官方
 * 下载页，点一次 Windows 版下载按钮，截下页面生成的签名直链，再交给应用
 * 自己的下载管线（进度/限速/线路/历史）直接落盘并解压。用户全程只看见
 * 一个下载任务，不需要面对浏览器窗口。
 *
 * 抓不到链接（页面改版、网络异常）时退回可见的下载页，仍能手动完成。
 */

export interface HarmonyDownloadResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
}

export type HarmonyDownloadReply =
  | { started: true; desc: string }
  | { started: false; reason: 'busy' | 'window' };

const TASK_KEY = 'harmony-commandline-tools';
const TASK_DESC = 'HarmonyOS 命令行工具';
const FALLBACK_FILE = 'commandline-tools-windows-x64.zip';
const SCRAPE_TIMEOUT_MS = 60_000;

let win: BrowserWindow | null = null;
let hooked = false;
let importing = false;
// 只接管本页及其弹窗的下载：同分区里的其它窗口（含扫描用的隐藏窗口）不归这里
const ownedContents = new Set<number>();
let ctx: {
  targetDir: string;
  onResult: (r: HarmonyDownloadResult) => void;
} | null = null;

export function openHarmonyDownloadCenter(opts: {
  targetDir: string;
  onResult: (r: HarmonyDownloadResult) => void;
}): void {
  ctx = opts;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return;
  }
  if (!hooked) {
    hooked = true;
    session
      .fromPartition(HUAWEI_PARTITION)
      .on('will-download', (_e, item, webContents) => {
        if (autoBusy) return;
        if (!ownedContents.has(webContents.id)) return;
        if (webContents.getURL().includes('oauth-login')) return;
        handleDownload(item, webContents);
      });
  }
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    title: 'HarmonyOS 命令行工具下载',
    backgroundColor: '#ffffff',
    webPreferences: { partition: HUAWEI_PARTITION },
  });
  const mainId = win.webContents.id;
  ownedContents.add(mainId);
  // 签名直链的弹窗只承担下载，隐藏避免空白窗口闪烁
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      show: false,
      webPreferences: { partition: HUAWEI_PARTITION },
    },
  }));
  win.webContents.on('did-create-window', (child) => {
    const id = child.webContents.id;
    ownedContents.add(id);
    child.on('closed', () => ownedContents.delete(id));
  });
  void win.loadURL(HARMONY_MANUAL_URL);
  win.on('closed', () => {
    win = null;
    ownedContents.clear();
  });
}

function handleDownload(item: DownloadItem, srcContents: WebContents): void {
  const name = item.getFilename() || '';
  if (!/\.zip$/i.test(name)) return;
  // 连点会并发下载多个 2.5GB 安装包并争抢同一落位目录
  if (importing) {
    item.cancel();
    const dup = BrowserWindow.fromWebContents(srcContents);
    if (dup && dup !== win) dup.close();
    return;
  }
  importing = true;
  const zipPath = path.join(
    os.tmpdir(),
    'devemu-env-dl',
    `${Date.now()}-${name}`,
  );
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  item.setSavePath(zipPath);

  const targetDir = ctx?.targetDir ?? '';
  const popup = BrowserWindow.fromWebContents(srcContents);
  const task = adoptExternalDownload({
    key: TASK_KEY,
    desc: TASK_DESC,
    onCancel: () => item.cancel(),
    postProcess: async (filePath, setPct) => {
      if (!targetDir) throw new Error('未配置 HarmonyOS SDK 目录');
      await importCommandlineTools(filePath, targetDir);
      setPct(95);
    },
    onDone: (r) => {
      importing = false;
      try {
        fs.rmSync(zipPath, { force: true });
      } catch {
        // 临时文件清理失败忽略
      }
      if (popup && popup !== win && !popup.isDestroyed()) popup.close();
      // 成功后关闭下载页；失败/取消保留窗口方便重试
      if (r.ok && win && !win.isDestroyed()) win.close();
      ctx?.onResult({ ok: r.ok, cancelled: r.cancelled, error: r.error });
    },
  });

  item.on('updated', () => {
    task.progress(item.getReceivedBytes(), item.getTotalBytes());
  });
  item.once('done', (_e, state) => {
    if (state === 'completed')
      void task.complete(item.getSavePath() || zipPath);
    else if (state === 'cancelled') task.fail('已取消');
    else task.fail('下载中断');
  });
}

interface ScrapedUrl {
  url: string;
  fileName: string;
}

function safeFileName(raw: string): string {
  const name = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '');
  return /\.zip$/i.test(name) ? name : FALLBACK_FILE;
}

function zipFileNameOf(url: string): string {
  try {
    return safeFileName(
      decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''),
    );
  } catch {
    return FALLBACK_FILE;
  }
}

/** 在隐藏窗口里点官方下载按钮，截获页面生成的签名直链（不实际下载） */
function resolveHarmonyDownloadUrl(
  timeoutMs = SCRAPE_TIMEOUT_MS,
): Promise<ScrapedUrl | null> {
  return new Promise((resolve) => {
    const part = session.fromPartition(HUAWEI_PARTITION);
    let scrapeWin: BrowserWindow | null = null;
    const popupIds = new Set<number>();
    const popupWins: BrowserWindow[] = [];
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let lastClick = 0;
    const startedAt = Date.now();

    const finish = (r: ScrapedUrl | null) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (deadline) clearTimeout(deadline);
      part.off('will-download', onWillDownload);
      resolve(r);
      // 可能从 window.open / will-download 的回调里触发，同步销毁会打断事件处理
      setImmediate(() => {
        for (const p of popupWins) if (!p.isDestroyed()) p.destroy();
        if (scrapeWin && !scrapeWin.isDestroyed()) scrapeWin.destroy();
      });
    };

    const capture = (url: string): boolean => {
      if (!/^https:\/\//i.test(url) || !/\.zip(\?|#|$)/i.test(url)) return false;
      finish({ url, fileName: zipFileNameOf(url) });
      return true;
    };

    // 页面若直接把直链交给浏览器下载（而不是 window.open），这里取回同一地址
    const onWillDownload = (
      _e: Electron.Event,
      item: DownloadItem,
      wc: WebContents,
    ) => {
      if (settled) return;
      if (!scrapeWin) return;
      if (wc !== scrapeWin.webContents && !popupIds.has(wc.id)) return;
      const url = item.getURL();
      const name = item.getFilename() || '';
      // 只要链接：真下载会白拉 2.5GB 到 Electron 的默认目录
      item.cancel();
      if (!/\.zip$/i.test(name) && !/\.zip(\?|#|$)/i.test(url)) return;
      finish({
        url,
        fileName: /\.zip$/i.test(name) ? safeFileName(name) : zipFileNameOf(url),
      });
    };
    part.on('will-download', onWillDownload);

    scrapeWin = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 1180,
      height: 800,
      webPreferences: {
        partition: HUAWEI_PARTITION,
        backgroundThrottling: false,
      },
    });

    scrapeWin.webContents.setWindowOpenHandler(({ url }) => {
      if (capture(url)) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          skipTaskbar: true,
          webPreferences: {
            partition: HUAWEI_PARTITION,
            backgroundThrottling: false,
          },
        },
      };
    });
    scrapeWin.webContents.on('did-create-window', (child) => {
      popupIds.add(child.webContents.id);
      popupWins.push(child);
      child.webContents.on('will-navigate', (e, url) => {
        if (capture(url)) e.preventDefault();
      });
    });
    scrapeWin.webContents.on('will-navigate', (e, url) => {
      if (capture(url)) e.preventDefault();
    });

    const clickDownload = `(() => {
      const rows = Array.from(document.querySelectorAll('.download-versions-item'));
      const row = rows.find((el) => /windows/i.test(el.textContent || '')) || rows[0];
      const btn = row && row.querySelector('.package-name');
      if (!btn) return false;
      btn.click();
      return true;
    })()`;

    deadline = setTimeout(() => finish(null), timeoutMs);
    pollTimer = setInterval(() => {
      if (settled || !scrapeWin || scrapeWin.isDestroyed()) return;
      // 加载初期可能短暂停在登录跳转链上，给 3 秒宽限再判定为未登录
      if (
        Date.now() - startedAt > 3000 &&
        scrapeWin.webContents.getURL().includes('oauth-login')
      ) {
        finish(null);
        return;
      }
      // 反复点会重复请求签名地址；签名接口偏慢时也只需每隔几秒补一次
      if (Date.now() - lastClick < 5000) return;
      lastClick = Date.now();
      void scrapeWin.webContents
        .executeJavaScript(clickDownload, true)
        .catch(() => false);
    }, 1000);

    void scrapeWin.loadURL(HARMONY_MANUAL_URL).catch(() => finish(null));
    scrapeWin.on('closed', () => {
      scrapeWin = null;
    });
  });
}

let autoBusy = false;

/** 一条龙：登录（如需）→ 抓签名直链 → 走应用下载管线 → 解压落位 */
export function startHarmonyDirectDownload(opts: {
  targetDir: string;
  viaProxy: boolean;
  proxyPort?: number;
  maxBps: number;
  onDone?: (r: HarmonyDownloadResult) => void;
}): HarmonyDownloadReply {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    return { started: false, reason: 'window' };
  }
  if (autoBusy || importing) return { started: false, reason: 'busy' };
  autoBusy = true;

  const run = async (): Promise<void> => {
    if (!(await hasHuaweiLogin())) {
      const loggedIn = await requestHuaweiLogin();
      if (!loggedIn) {
        autoBusy = false;
        opts.onDone?.({ ok: false, cancelled: true });
        return;
      }
    }
    const scraped = await resolveHarmonyDownloadUrl().catch(() => null);
    if (!scraped) {
      autoBusy = false;
      // 抓不到链接（页面改版/网络异常）：退回可见下载页手动完成
      openHarmonyDownloadCenter({
        targetDir: opts.targetDir,
        onResult: opts.onDone ?? (() => undefined),
      });
      return;
    }
    let target: URL;
    try {
      target = new URL(scraped.url);
    } catch {
      autoBusy = false;
      openHarmonyDownloadCenter({
        targetDir: opts.targetDir,
        onResult: opts.onDone ?? (() => undefined),
      });
      return;
    }
    startFileDownload({
      key: TASK_KEY,
      desc: TASK_DESC,
      host: target.host,
      path: target.pathname + target.search,
      fileName: scraped.fileName,
      viaProxy: opts.viaProxy,
      proxyPort: opts.proxyPort,
      maxBps: opts.maxBps,
      postProcess: async (filePath) => {
        await importCommandlineTools(filePath, opts.targetDir);
      },
      onDone: (r) => {
        autoBusy = false;
        opts.onDone?.({ ok: r.ok, cancelled: r.cancelled, error: r.error });
      },
    });
  };

  void run().catch((err: unknown) => {
    autoBusy = false;
    opts.onDone?.({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return { started: true, desc: TASK_DESC };
}
