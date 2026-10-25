import type { ApkMeta, AvdInfo, DeviceDef, HarmonyComponent, ProjectMeta, RunRecord, Settings, SdkInfo, SystemImage } from '../core/types.ts';

export type { HarmonyComponent };

export type Scope = { kind: 'project'; projectId: string } | { kind: 'shared' };
export type R<T> = { ok: true; data: T } | { ok: false; error: string };
export type EmuDevice = { serial: string; state: string; avdName?: string; type?: 'android' | 'harmonyos' };
export type SdkPkg = { pkg: string; version: string; desc: string };
export type HarmonyInfo = {
  sdkRoot: string;
  hdc: string;
  deveco?: string;
  emulator?: string;
  apiVersion?: string;
  components: HarmonyComponent[];
};

export function osFromImagePkg(pkg?: string): string {
  const m = pkg?.match(/android-([\d.]+)/);
  if (!m) return pkg ? 'Android' : '—';
  const api = parseFloat(m[1]);
  const map: Record<number, string> = {
    21: '5.0', 22: '5.1', 23: '6', 24: '7', 25: '7.1', 26: '8', 27: '8.1', 28: '9', 29: '10',
    30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16',
  };
  return map[api] ? `Android ${map[api]}` : `Android (API ${m[1]})`;
}

export function prettyModel(deviceName?: string): string {
  if (!deviceName) return '—';
  return deviceName
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 && /^\d/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}
export type OpResult = { ok: boolean; error?: string };

interface RawApi {
  [channel: string]: (...args: unknown[]) => Promise<unknown>;
}

const raw = (window as unknown as { devemu: RawApi }).devemu;

async function call<T>(channel: string, ...args: unknown[]): Promise<R<T>> {
  return (await raw[channel](...args)) as R<T>;
}

export function onSdkProgress(cb: (line: string) => void): () => void {
  const fn = (window as unknown as { devemu: { onSdkProgress?: (cb: (line: string) => void) => () => void } }).devemu
    .onSdkProgress;
  return fn ? fn(cb) : () => undefined;
}

export type DownloadItem = {
  pkg: string;
  desc: string;
  state: 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled';
  percent: number;
  downloaded: number;
  total: number;
  speedBps: number;
  etaSec: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export function onDownloadsChanged(cb: (snap: { active: DownloadItem[]; finished: DownloadItem[] }) => void): () => void {
  const api2 = (window as unknown as { devemu: { onDownloadsChanged?: (cb: (snap: unknown) => void) => () => void } }).devemu;
  return api2?.onDownloadsChanged
    ? api2.onDownloadsChanged((snap) => cb(snap as { active: DownloadItem[]; finished: DownloadItem[] }))
    : () => undefined;
}

/** 环境安装目标（设置页 SDK 分区三行） */
export type EnvKind = 'android' | 'harmonyos' | 'java';

export const ENV_LABELS: Record<EnvKind, string> = {
  android: 'Android SDK',
  harmonyos: 'HarmonyOS SDK',
  java: 'Java 运行环境',
};

export type EnvInstallResult = { label: string; ok: boolean; cancelled?: boolean; error?: string };

export function onEnvChanged(cb: () => void): () => void {
  const api2 = (window as unknown as { devemu: { onEnvChanged?: (cb: (payload: unknown) => void) => () => void } }).devemu;
  return api2?.onEnvChanged ? api2.onEnvChanged(() => cb()) : () => undefined;
}

export function onEnvInstallResult(cb: (r: EnvInstallResult) => void): () => void {
  const api2 = (window as unknown as { devemu: { onEnvInstallResult?: (cb: (payload: unknown) => void) => () => void } }).devemu;
  return api2?.onEnvInstallResult ? api2.onEnvInstallResult((p) => cb(p as EnvInstallResult)) : () => undefined;
}

export function onWinMaximized(cb: (maximized: boolean) => void): () => void {
  const fn = (window as unknown as { devemu: { onWinMaximized?: (cb: (m: boolean) => void) => () => void } }).devemu
    .onWinMaximized;
  return fn ? fn(cb) : () => undefined;
}

export type AutoInstallPayload = {
  avdName: string;
  results: { id: string; label: string; ok: boolean; error?: string }[];
};

export function onAutoInstall(cb: (payload: AutoInstallPayload) => void): () => void {
  const fn = (window as unknown as { devemu: { onAutoInstall?: (cb: (p: unknown) => void) => () => void } }).devemu
    .onAutoInstall;
  return fn ? fn((p) => cb(p as AutoInstallPayload)) : () => undefined;
}

export type RouteId = 'direct' | 'proxy';
export type RouteProbe = {
  id: RouteId;
  name: string;
  ok: boolean;
  latencyMs: number;
  loss: number;
  speedBps: number;
};

export const api = {
  winMinimize: () => call<boolean>('winMinimize'),
  winToggleMaximize: () => call<boolean>('winToggleMaximize'),
  winClose: () => call<boolean>('winClose'),
  winIsMaximized: () => call<boolean>('winIsMaximized'),
  checkUpdate: () => call<{ latest: string; current: string; upToDate: boolean; url: string }>('checkUpdate'),
  envCheckDir: (kind: EnvKind, dir: string) => call<{ found: boolean }>('env:checkDir', kind, dir),
  envInstall: (kind: EnvKind, dir: string) =>
    call<{ manual?: boolean; url?: string; label: string }>('env:install', kind, dir),
  envStatus: () =>
    call<{ settings: Settings; sdk: SdkInfo | null; java: string | null; harmony: HarmonyInfo | null; version: string; images: SystemImage[] }>('envStatus'),
  saveSettings: (s: Settings) => call<Settings>('saveSettings', s),
  probeRoutes: (system: 'android' | 'harmonyos') => call<RouteProbe[]>('probeRoutes', system),
  harmonyTargets: () => call<string[]>('harmonyTargets'),
  harmonyUninstall: (dir: string) => call<boolean>('harmonyUninstall', dir),
  openUrl: (url: string) => call<boolean>('openUrl', url),
  sdkInstalled: () => call<SdkPkg[]>('sdkInstalled'),
  sdkAvailable: () => call<SdkPkg[]>('sdkAvailable'),
  sdkInstall: (pkg: string) => call<boolean>('sdkInstall', pkg),
  sdkUninstall: (pkg: string) => call<boolean>('sdkUninstall', pkg),
  downloadsList: () => call<{ active: DownloadItem[]; finished: DownloadItem[] }>('downloadsList'),
  downloadsCancel: (pkg: string) => call<boolean>('downloadsCancel', pkg),
  listProjects: () => call<ProjectMeta[]>('listProjects'),
  createProject: (name: string, note?: string) => call<ProjectMeta>('createProject', name, note),
  updateProject: (id: string, patch: { name?: string; note?: string }) => call<ProjectMeta | null>('updateProject', id, patch),
  deleteProject: (id: string) => call<boolean>('deleteProject', id),
  listAvds: (scope: Scope) => call<AvdInfo[]>('listAvds', scope),
  createAvd: (
    scope: Scope,
    name: string,
    imagePkg: string,
    deviceDefId: string,
    hw?: { ramMb?: number; cores?: number; storageGb?: number },
  ) => call<OpResult>('createAvd', scope, name, imagePkg, deviceDefId, hw),
  deleteAvd: (scope: Scope, name: string) => call<OpResult>('deleteAvd', scope, name),
  avdHardware: (scope: Scope, name: string) =>
    call<{ ramMb?: number; cores?: number; storageGb?: number } | null>('avdHardware', scope, name),
  setAvdHardware: (scope: Scope, name: string, hw: { ramMb?: number; cores?: number; storageGb?: number }) =>
    call<OpResult>('setAvdHardware', scope, name, hw),
  renameAvd: (scope: Scope, oldName: string, newName: string) => call<OpResult>('renameAvd', scope, oldName, newName),
  deviceDefs: () => call<{ ok: boolean; defs?: DeviceDef[]; error?: string }>('deviceDefs'),
  launchEmu: (scope: Scope, avdName: string) => call<{ avdName: string; port: number; serial: string }>('launchEmu', scope, avdName),
  stopEmu: (scope: Scope, avdName: string) => call<boolean>('stopEmu', scope, avdName),
  listEmulators: () => call<EmuDevice[]>('listEmulators'),
  openApkDialog: () => call<string | null>('openApkDialog'),
  openDirDialog: (title?: string) => call<string | null>('openDirDialog', title),
  importApk: (scope: Scope, filePath: string) => call<ApkMeta>('importApk', scope, filePath),
  listApps: (scope: Scope) => call<ApkMeta[]>('listApps', scope),
  removeApk: (scope: Scope, id: string) => call<boolean>('removeApk', scope, id),
  install: (scope: Scope, apkId: string, serial: string) => call<OpResult>('install', scope, apkId, serial),
  launch: (scope: Scope, apkId: string, serial: string) => call<OpResult>('launch', scope, apkId, serial),
  screenshot: (serial: string) => call<string>('screenshot', serial),
  logcat: (serial: string) => call<string>('logcat', serial),
  clearData: (scope: Scope, apkId: string, serial: string) => call<boolean>('clearData', scope, apkId, serial),
  uninstall: (scope: Scope, apkId: string, serial: string) => call<boolean>('uninstall', scope, apkId, serial),
  recordRun: (scope: Scope, p: { avdName: string; serial: string; apkId?: string; result: string; note?: string }) =>
    call<RunRecord>('recordRun', scope, p),
  listRuns: (scope: Scope) => call<RunRecord[]>('listRuns', scope),
};
