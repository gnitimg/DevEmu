import { contextBridge, ipcRenderer } from 'electron';

function invoke(channel: string): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('devemu', {
  envStatus: invoke('env:status'),
  saveSettings: invoke('settings:save'),
  sdkPackages: invoke('sdk:packages'),
  sdkInstall: invoke('sdk:install'),
  sdkUninstall: invoke('sdk:uninstall'),
  listProjects: invoke('project:list'),
  createProject: invoke('project:create'),
  updateProject: invoke('project:update'),
  deleteProject: invoke('project:delete'),
  listAvds: invoke('avd:list'),
  createAvd: invoke('avd:create'),
  deleteAvd: invoke('avd:delete'),
  avdHardware: invoke('avd:hardware'),
  setAvdHardware: invoke('avd:setHardware'),
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
