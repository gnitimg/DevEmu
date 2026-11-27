import { contextBridge, ipcRenderer } from 'electron';
import { readSharedFrame } from './core/sharedFrame.ts';
import { CAPTURE_ROLE_ARG } from './core/captureProtocol.ts';
import type { CaptureCommand, CaptureEvent, FrameNotice } from './core/captureProtocol.ts';

function invoke(channel: string): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

// 录屏工作窗多一层桥：收主进程的命令与帧通知，回传编码分块。
// 与药丸/定位面板同一姿态——带全量 API 的自家窗口，靠拦导航做纵深防御。
if (process.argv.includes(CAPTURE_ROLE_ARG)) {
  let fsModule: Promise<typeof import('node:fs')> | undefined;
  // node:fs 按需引入：这份 preload 也跑在沙箱化的主窗里，顶层引入会让它们全部加载失败
  const loadFs = () =>
    (fsModule ??= import(/* @vite-ignore */ 'node:fs').then(
      (m) => (m.default ?? m) as typeof import('node:fs'),
    ));
  contextBridge.exposeInMainWorld('devemuCapture', {
    onCommand: (cb: (cmd: CaptureCommand) => void) => {
      const listener = (_e: unknown, cmd: CaptureCommand) => cb(cmd);
      ipcRenderer.on('capture:command', listener);
      return () => ipcRenderer.removeListener('capture:command', listener);
    },
    // 像素在共享文件里，由 preload 读好再过桥；读不到给 null
    onFrame: (cb: (notice: FrameNotice, pixels: ArrayBuffer | null) => void) => {
      const listener = (_e: unknown, notice: FrameNotice) => {
        void loadFs().then(
          (fs) => cb(notice, readSharedFrame(fs, notice)),
          () => cb(notice, null),
        );
      };
      ipcRenderer.on('capture:frame', listener);
      return () => ipcRenderer.removeListener('capture:frame', listener);
    },
    send: (event: CaptureEvent) => ipcRenderer.send('capture:event', event),
  });
}

contextBridge.exposeInMainWorld('devemu', {
  winMinimize: invoke('win:minimize'),
  winToggleMaximize: invoke('win:toggleMaximize'),
  winClose: invoke('win:close'),
  winIsMaximized: invoke('win:isMaximized'),
  onWinMaximized: (cb: (maximized: boolean) => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on('win:maximized', listener);
    return () => ipcRenderer.removeListener('win:maximized', listener);
  },
  onAutoInstall: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('apk:autoinstall', listener);
    return () => ipcRenderer.removeListener('apk:autoinstall', listener);
  },
  envStatus: invoke('env:status'),
  envCheckDir: invoke('env:checkDir'),
  envInstall: invoke('env:install'),
  onEnvChanged: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('env:changed', listener);
    return () => ipcRenderer.removeListener('env:changed', listener);
  },
  saveSettings: invoke('settings:save'),
  checkDataRoot: invoke('settings:checkDataRoot'),
  probeRoutes: invoke('settings:probe'),
  firstRun: invoke('app:firstRun'),
  checkUpdate: invoke('app:checkUpdate'),
  updateDownload: invoke('update:download'),
  updateCancel: invoke('update:cancel'),
  updateInstall: invoke('update:install'),
  onUpdateAvailable: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('update:available', listener);
    return () => ipcRenderer.removeListener('update:available', listener);
  },
  onUpdateProgress: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  onUpdateDownloaded: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('update:downloaded', listener);
    return () => ipcRenderer.removeListener('update:downloaded', listener);
  },
  onUpdatePatch: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('update:patch', listener);
    return () => ipcRenderer.removeListener('update:patch', listener);
  },
  onUpdateError: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('update:error', listener);
    return () => ipcRenderer.removeListener('update:error', listener);
  },
  harmonyTargets: invoke('harmony:targets'),
  harmonyUninstall: invoke('harmony:uninstall'),
  hosList: invoke('hos:list'),
  hosImages: invoke('hos:images'),
  hosScreenProfiles: invoke('hos:screenProfiles'),
  hosCreate: invoke('hos:create'),
  hosStart: invoke('hos:start'),
  hosStop: invoke('hos:stop'),
  hosDelete: invoke('hos:delete'),
  hosSetHardware: invoke('hos:setHardware'),
  hosRename: invoke('hos:rename'),
  hosAcceptLicense: invoke('hos:acceptLicense'),
  hosDownloadImage: invoke('hos:downloadImage'),
  hosUninstallImage: invoke('hos:uninstallImage'),
  onHosStartFailed: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('hos:startFailed', listener);
    return () => ipcRenderer.removeListener('hos:startFailed', listener);
  },
  openUrl: invoke('open:url'),
  huaweiState: invoke('huawei:state'),
  huaweiLogin: invoke('huawei:login'),
  huaweiDownloadCenter: invoke('huawei:downloadCenter'),
  onHuaweiChanged: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('huawei:changed', listener);
    return () => ipcRenderer.removeListener('huawei:changed', listener);
  },
  sdkInstalled: invoke('sdk:installed'),
  sdkAvailable: invoke('sdk:available'),
  sdkInstall: invoke('sdk:install'),
  sdkUninstall: invoke('sdk:uninstall'),
  downloadsList: invoke('downloads:list'),
  downloadsCancel: invoke('downloads:cancel'),
  downloadsRemove: invoke('downloads:remove'),
  onDownloadsChanged: (cb: (snap: unknown) => void) => {
    const listener = (_e: unknown, snap: unknown) => cb(snap);
    ipcRenderer.on('downloads:changed', listener);
    return () => ipcRenderer.removeListener('downloads:changed', listener);
  },
  onSdkProgress: (cb: (line: string) => void) => {
    const listener = (_e: unknown, line: string) => cb(line);
    ipcRenderer.on('sdk:progress', listener);
    return () => ipcRenderer.removeListener('sdk:progress', listener);
  },
  listProjects: invoke('project:list'),
  createProject: invoke('project:create'),
  updateProject: invoke('project:update'),
  deleteProject: invoke('project:delete'),
  listAvds: invoke('avd:list'),
  createAvd: invoke('avd:create'),
  deleteAvd: invoke('avd:delete'),
  avdHardware: invoke('avd:hardware'),
  setAvdHardware: invoke('avd:setHardware'),
  renameAvd: invoke('avd:rename'),
  deviceDefs: invoke('avd:deviceDefs'),
  cameraWebcams: invoke('camera:webcams'),
  launchEmu: invoke('emu:launch'),
  stopEmu: invoke('emu:stop'),
  restartRunningEmus: invoke('emu:restartRunning'),
  listEmulators: invoke('emu:list'),
  openApkDialog: invoke('dialog:openApk'),
  openDirDialog: invoke('dialog:openDir'),
  openZipDialog: invoke('dialog:openZip'),
  harmonyImportZip: invoke('harmony:importZip'),
  importApk: invoke('apk:import'),
  listApps: invoke('apk:list'),
  removeApk: invoke('apk:remove'),
  install: invoke('test:install'),
  launch: invoke('test:launch'),
  screenshot: invoke('test:screenshot'),
  logcat: invoke('test:logcat'),
  clearData: invoke('test:clearData'),
  uninstall: invoke('test:uninstall'),
  listCrashes: invoke('crash:list'),
  readCrash: invoke('crash:read'),
  onCrashRecorded: (cb: (record: unknown) => void) => {
    const listener = (_e: unknown, record: unknown) => cb(record);
    ipcRenderer.on('crash:recorded', listener);
    return () => ipcRenderer.removeListener('crash:recorded', listener);
  },
  agentStatus: invoke('agent:status'),
  agentApply: invoke('agent:apply'),
  agentRegenerateToken: invoke('agent:regenerateToken'),
  pillAction: invoke('pill:action'),
  pillMoveStart: invoke('pill:move-start'),
  pillOpenLocation: invoke('pill:open-location'),
  captureToggle: invoke('capture:toggle'),
  captureStatus: invoke('capture:status'),
  onCaptureState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on('capture:state', listener);
    return () => ipcRenderer.removeListener('capture:state', listener);
  },
  onCaptureSaved: (cb: (info: unknown) => void) => {
    const listener = (_e: unknown, info: unknown) => cb(info);
    ipcRenderer.on('capture:saved', listener);
    return () => ipcRenderer.removeListener('capture:saved', listener);
  },
  onToast: (cb: (info: unknown) => void) => {
    const listener = (_e: unknown, info: unknown) => cb(info);
    ipcRenderer.on('toast:show', listener);
    return () => ipcRenderer.removeListener('toast:show', listener);
  },
  notify: invoke('app:notify'),
  avdPrefs: invoke('avd:prefs'),
  setAvdPrefs: invoke('avd:setPrefs'),
  locationStart: invoke('location:start'),
  locationStop: invoke('location:stop'),
  locationPause: invoke('location:pause'),
  locationStatus: invoke('location:status'),
  locationNudge: invoke('location:nudge'),
  locationTeleport: invoke('location:teleport'),
  routeSave: invoke('route:save'),
  routeList: invoke('route:list'),
  routeParse: invoke('route:parse'),
  routeDelete: invoke('route:delete'),
  locPrefsLoad: invoke('locprefs:load'),
  locPrefsSave: invoke('locprefs:save'),
  storageInfo: invoke('storage:info'),
  storageReveal: invoke('storage:reveal'),
  storageClearLogs: invoke('storage:clearLogs'),
  storageClearAvds: invoke('storage:clearAvds'),
  storageReset: invoke('storage:reset'),
  storageMigrateProbe: invoke('storage:migrateProbe'),
  storageMigrateData: invoke('storage:migrateData'),
  onMigrateProgress: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('storage:migrateProgress', listener);
    return () => ipcRenderer.removeListener('storage:migrateProgress', listener);
  },
  restartApp: invoke('app:restart'),
});
