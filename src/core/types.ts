/** 作用域：项目隔离 或 设备池公共 */
export type Scope = { kind: 'project'; projectId: string } | { kind: 'shared' };

/** 虚拟机调用相机时的画面来源 */
export type CameraMode = 'emulated' | 'webcam' | 'screen';

export interface Settings {
  dataRoot: string;
  sdkPath?: string;
  javaPath?: string;
  /** HarmonyOS SDK 根目录（含 default/openharmony 等结构） */
  harmonySdkPath?: string;
  /** 模拟器图形后端：angle_indirect / swiftshader_indirect / host */
  gpuMode?: string;
  /** 旧默认 swiftshader_indirect 全黑问题的一次性迁移标记（随任一次设置保存落盘） */
  gpuSwiftshaderMigrated?: boolean;
  /** 相机画面来源（仅 Android 虚拟机），缺省 emulated */
  cameraMode?: CameraMode;
  /** cameraMode=webcam 时使用的摄像头（webcam0/webcam1...），缺省 webcam0 */
  webcam?: string;
  /** 模拟器操作中心（屏幕右侧药丸工具条），默认启用 */
  pillEnabled?: boolean;
  /** 设备网络代理 */
  proxyEnabled?: boolean;
  proxyPort?: number;
  /** Android SDK 下载线路：direct 直连 / proxy 本地代理 */
  androidDownloadRoute?: 'direct' | 'proxy';
  /** HarmonyOS SDK 下载线路：direct 直连 / proxy 本地代理 */
  harmonyDownloadRoute?: 'direct' | 'proxy';
  /** 最高下载速度 KB/s，0 或缺省为无限制 */
  maxDownloadKbps?: number;
  /** 并行下载数 1-4 */
  parallelDownloads?: number;
  /** 启动后与定期自动检查更新，默认启用（缺省视为开启） */
  autoCheckUpdate?: boolean;
  /** Agent 控制桥：允许本机 AI agent 经 HTTP/MCP 控制在线虚拟设备 */
  agentEnabled?: boolean;
  agentPort?: number;
  agentToken?: string;
}

export interface SdkInfo {
  root: string;
  adb: string;
  emulator: string;
  avdmanager?: string;
  sdkmanager?: string;
  aapt?: string;
}

/** HarmonyOS SDK 组件（openharmony / hms 下的子目录） */
export interface HarmonyComponent {
  name: string;
  dir: string;
  version?: string;
}

/** HarmonyOS 环境探测结果 */
export interface HarmonyInfo {
  /** SDK 根（含 default 或版本号子目录的那一层） */
  sdkRoot: string;
  hdc: string;
  /** DevEco Studio 安装目录（如有） */
  deveco?: string;
  /** DevEco 模拟器可执行文件（如有） */
  emulator?: string;
  /** 从 uni-package.json 推断的 SDK 版本 */
  apiVersion?: string;
  components: HarmonyComponent[];
}

/** 一台 HarmonyOS 模拟器实例（Emulator.exe -list -details 归一化） */
export interface HosAvd {
  name: string;
  deviceType: string;
  osVersion: string;
  apiVersion?: string;
  softwareVersion?: string;
  productModel?: string;
  deviceModel?: string;
  ramMb?: number;
  storageMb?: number;
  cpuCores?: number;
  instancePath?: string;
  resolution?: string;
  running: boolean;
}

/** HarmonyOS 模拟器镜像（Emulator.exe -imageList） */
export interface HosImage {
  deviceType: string;
  osVersion: string;
  softwareVersion: string;
  releaseType?: string;
  downloaded: boolean;
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
  /** 包类型：apk（缺省）/ hap */
  kind?: 'apk' | 'hap';
  label?: string;
  packageName?: string;
  versionName?: string;
  /** APK 入口 Activity / HAP 入口 ability */
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

export type CrashKind = 'java' | 'native' | 'anr' | 'other';

export interface CrashRecord {
  id: string;
  /** android = Android 虚拟机，hos = HarmonyOS 虚拟机 */
  os: 'android' | 'hos';
  /** 崩溃发生时间（ISO；HOS 历史记录取故障日志自带时间） */
  at: string;
  /** 设备名称（虚拟机名称） */
  device: string;
  /** 故障源：应用包名/进程名；系统级进程为 SYSTEM */
  source: string;
  /** 故障源显示名（应用库已知标签） */
  sourceLabel?: string;
  kind: CrashKind;
  /** 报错摘要，完整内容在 log 指向的文件里 */
  summary: string;
  /** 详情文件名（相对记录目录） */
  log?: string;
  /** 去重键（HOS faultlogger 文件名），避免重启后重复导入 */
  key?: string;
}
