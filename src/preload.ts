import { contextBridge, ipcRenderer } from 'electron';

function invoke(channel: string): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
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
  onEnvInstallResult: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on('env:installResult', listener);
    return () => ipcRenderer.removeListener('env:installResult', listener);
  },
  saveSettings: invoke('settings:save'),
  probeRoutes: invoke('settings:probe'),
  checkUpdate: invoke('app:checkUpdate'),
  harmonyTargets: invoke('harmony:targets'),
  harmonyUninstall: invoke('harmony:uninstall'),
  openUrl: invoke('open:url'),
  huaweiState: invoke('huawei:state'),
  huaweiLogin: invoke('huawei:login'),
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
  listEmulators: invoke('emu:list'),
  openApkDialog: invoke('dialog:openApk'),
  openDirDialog: invoke('dialog:openDir'),
  importApk: invoke('apk:import'),
  listApps: invoke('apk:list'),
  removeApk: invoke('apk:remove'),
  install: invoke('test:install'),
  launch: invoke('test:launch'),
  screenshot: invoke('test:screenshot'),
  logcat: invoke('test:logcat'),
  clearData: invoke('test:clearData'),
  uninstall: invoke('test:uninstall'),
  recordRun: invoke('run:record'),
  listRuns: invoke('run:list'),
  agentStatus: invoke('agent:status'),
  agentApply: invoke('agent:apply'),
  agentRegenerateToken: invoke('agent:regenerateToken'),
  pillAction: invoke('pill:action'),
  pillMoveStart: invoke('pill:move-start'),
  pillOpenLocation: invoke('pill:open-location'),
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
});
