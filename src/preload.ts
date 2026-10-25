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
  envStatus: invoke('env:status'),
  saveSettings: invoke('settings:save'),
  probeRoutes: invoke('settings:probe'),
  sdkInstalled: invoke('sdk:installed'),
  sdkAvailable: invoke('sdk:available'),
  sdkInstall: invoke('sdk:install'),
  sdkUninstall: invoke('sdk:uninstall'),
  downloadsList: invoke('downloads:list'),
  downloadsCancel: invoke('downloads:cancel'),
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
});
