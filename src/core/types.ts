/** 作用域：项目隔离 或 设备池公共 */
export type Scope = { kind: 'project'; projectId: string } | { kind: 'shared' };

export interface Settings {
  dataRoot: string;
  sdkPath?: string;
  javaPath?: string;
}

export interface SdkInfo {
  root: string;
  adb: string;
  emulator: string;
  avdmanager?: string;
  sdkmanager?: string;
  aapt?: string;
}

export interface SystemImage {
  pkg: string; // system-images;android-35;google_apis;x86_64
  api: number;
  tag: string;
  abi: string;
}

export interface AvdInfo {
  name: string;
  iniPath: string;
  imagePkg?: string;
  deviceName?: string;
}

export interface DeviceDef {
  id: string;
  name: string;
}

export interface DeviceInfo {
  serial: string;
  state: string; // device | offline | unauthorized | ...
  avdName?: string;
}

export interface ApkMeta {
  id: string;
  fileName: string;
  label?: string;
  packageName?: string;
  versionName?: string;
  activity?: string;
  size: number;
  importedAt: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  avdName: string;
  apkLabel?: string;
  packageName?: string;
  result: 'ok' | 'install-failed' | 'launch-failed' | 'manual';
  note?: string;
  screenshot?: string; // 相对 runs/<id>/ 的文件名
  logcat?: string;
  at: string;
}
