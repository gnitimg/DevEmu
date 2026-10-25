import type { ApkMeta, AvdInfo, DeviceDef, ProjectMeta, RunRecord, Settings, SdkInfo, SystemImage } from '../core/types.ts';

export type Scope = { kind: 'project'; projectId: string } | { kind: 'shared' };
export type R<T> = { ok: true; data: T } | { ok: false; error: string };
export type EmuDevice = { serial: string; state: string; avdName?: string };
export type ImageEntry = { pkg: string; version: string; desc: string };
export type OpResult = { ok: boolean; error?: string };

interface RawApi {
  [channel: string]: (...args: unknown[]) => Promise<unknown>;
}

const raw = (window as unknown as { devemu: RawApi }).devemu;

async function call<T>(channel: string, ...args: unknown[]): Promise<R<T>> {
  return (await raw[channel](...args)) as R<T>;
}

export const api = {
  envStatus: () =>
    call<{ settings: Settings; sdk: SdkInfo | null; java: string | null; images: SystemImage[] }>('envStatus'),
  saveSettings: (s: Settings) => call<Settings>('saveSettings', s),
  availableImages: () => call<ImageEntry[]>('availableImages'),
  downloadImage: (pkg: string) => call<boolean>('downloadImage', pkg),
  listProjects: () => call<ProjectMeta[]>('listProjects'),
  createProject: (name: string, note?: string) => call<ProjectMeta>('createProject', name, note),
  updateProject: (id: string, patch: { name?: string; note?: string }) => call<ProjectMeta | null>('updateProject', id, patch),
  deleteProject: (id: string) => call<boolean>('deleteProject', id),
  listAvds: (scope: Scope) => call<AvdInfo[]>('listAvds', scope),
  createAvd: (scope: Scope, name: string, imagePkg: string, deviceDefId: string) => call<OpResult>('createAvd', scope, name, imagePkg, deviceDefId),
  deleteAvd: (scope: Scope, name: string) => call<OpResult>('deleteAvd', scope, name),
  deviceDefs: () => call<{ ok: boolean; defs?: DeviceDef[]; error?: string }>('deviceDefs'),
  launchEmu: (scope: Scope, avdName: string) => call<{ avdName: string; port: number; serial: string }>('launchEmu', scope, avdName),
  stopEmu: (scope: Scope, avdName: string) => call<boolean>('stopEmu', scope, avdName),
  listEmulators: () => call<EmuDevice[]>('listEmulators'),
  openApkDialog: () => call<string | null>('openApkDialog'),
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
