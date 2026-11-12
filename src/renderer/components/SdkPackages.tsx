import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  onDownloadsChanged,
  onHuaweiChanged,
  type DownloadItem,
  type HarmonyComponent,
  type HosImage,
  type SdkPkg,
} from '../api.ts';
import { Segmented } from './Segmented.tsx';
import { flyToDownloads } from './Fly.tsx';
import { Select } from './Select.tsx';
import { toast } from './Toast.tsx';
import {
  HOS_IMAGE_FAMILIES,
  groupHosImages,
  hosImageKey,
  hosSeries,
  type HosImageGroup,
} from '../../core/hosLabels.ts';
import type { EnvStatus } from '../App.tsx';

type System = 'android' | 'harmonyos';

/** SDK 组件管理（内联于设置 SDK 分区）：右上角 Android/HarmonyOS 切换，两侧结构一致 */
export function SdkPackages({
  env,
  onChanged,
  onPickFolder,
  onOpenDownload,
  initialSystem,
}: {
  env: EnvStatus | null;
  onChanged: () => void;
  /** 未检测到 HarmonyOS SDK 时空态里的「选择已有文件夹」 */
  onPickFolder?: () => void;
  /** 后台获取官方下载地址直接下载，完成后自动解压落位 */
  onOpenDownload?: () => void;
  /** 从设备池跳转时直达对应系统页签 */
  initialSystem?: System;
}) {
  const [system, setSystem] = useState<System>(initialSystem ?? 'android');
  // 用户进来首先要找能装什么，可安装优先展示
  const [tab, setTab] = useState<'installed' | 'available'>('available');
  const [hosFamily, setHosFamily] = useState('phone');
  const [installed, setInstalled] = useState<SdkPkg[] | null>(null);
  const [available, setAvailable] = useState<SdkPkg[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [busyPkg, setBusyPkg] = useState('');

  // 进行中的下载任务（按包名索引），驱动安装按钮状态
  const [dl, setDl] = useState<Record<string, DownloadItem>>({});
  // 华为账号登录态：null 表示查询中；驱动空态按钮文案（登录 vs 打开下载中心）
  const [huaweiIn, setHuaweiIn] = useState<boolean | null>(null);
  // 命令行工具 zip 导入落位进行中（选包 → 选目录 → 解压）
  const [importingZip, setImportingZip] = useState(false);

  /** 导入从官方下载中心手动下载的 commandline-tools zip：解压到所选目录并写
   *  HarmonyOS SDK 路径，解决"登录了也没法下载"的最后一步落位 */
  async function importDownloadedZip(): Promise<void> {
    setImportingZip(true);
    try {
      const zip = await api.openZipDialog();
      if (!zip.ok || !zip.data) return;
      const dir = await api.openDirDialog('选择解压目标目录');
      if (!dir.ok || !dir.data) return;
      const r = await api.harmonyImportZip(zip.data, dir.data);
      if (!r.ok) {
        toast(r.error);
        return;
      }
      toast(`HarmonyOS 命令行工具已落位（hdc：${r.data.hdc}）`, 'ok');
      onChanged();
    } finally {
      setImportingZip(false);
    }
  }

  useEffect(() => {
    api
      .huaweiState()
      .then((r) => {
        if (r.ok) setHuaweiIn(r.data.loggedIn);
      })
      .catch(() => setHuaweiIn(false));
    return onHuaweiChanged(setHuaweiIn);
  }, []);

  const harmonyComponents: HarmonyComponent[] = env?.harmony?.components ?? [];

  // 系统镜像是 Emulator.exe 管理的独立资产，与命令行组件一起在已安装/可安装中展示
  const [hosImages, setHosImages] = useState<HosImage[] | null>(null);

  const reloadHosImages = useCallback(() => {
    if (!env?.harmony) {
      setHosImages([]);
      return;
    }
    api
      .hosImages()
      .then((r) => setHosImages(r.ok ? r.data : []))
      .catch(() => setHosImages([]));
  }, [env?.harmony]);

  useEffect(() => {
    if (system === 'harmonyos') reloadHosImages();
  }, [system, reloadHosImages]);

  const reloadInstalled = useCallback(() => {
    api.sdkInstalled().then((r) => {
      if (r.ok) setInstalled(r.data);
      else setError(r.error);
    });
  }, []);

  useEffect(reloadInstalled, [reloadInstalled]);

  // 可安装列表只在首次切到该页签时拉取（需联网，慢）
  useEffect(() => {
    if (tab !== 'available' || available !== null || loading) return;
    setLoading(true);
    setError('');
    api.sdkAvailable().then((r) => {
      if (r.ok) setAvailable(r.data);
      else setError(r.error);
      setLoading(false);
    });
  }, [tab, available, loading]);

  // 下载快照：多任务互不影响，各按钮只反映自己；任务从进行中消失
  // （完成/取消/失败）时刷新"已安装"列表，装完的包不再停留在"可安装"
  const prevActiveRef = useRef<Set<string>>(new Set());
  // 入队请求在途标记：IPC 往返窗口内可双击，且同包任务主进程不按包名去重；
  // 按包记在途，不同包允许并行入队
  const installBusyRef = useRef(new Set<string>());
  useEffect(
    () =>
      onDownloadsChanged((s) => {
        const m: Record<string, DownloadItem> = {};
        for (const d of s.active) m[d.pkg] = d;
        setDl(m);
        const now = new Set(Object.keys(m));
        let removed = false;
        for (const pkg of prevActiveRef.current) {
          if (!now.has(pkg)) {
            removed = true;
            break;
          }
        }
        if (removed) {
          reloadInstalled();
          reloadHosImages();
        }
        prevActiveRef.current = now;
      }),
    [reloadInstalled, reloadHosImages],
  );

  async function install(pkg: string, rect: DOMRect) {
    if (installBusyRef.current.has(pkg)) return;
    installBusyRef.current.add(pkg);
    flyToDownloads(rect);
    // 入队前的同步失败（缺 cmdline-tools 等）不产生下载任务，下载快照的
    // toast 不会触发：这里必须自己反馈
    try {
      const r = await api.sdkInstall(pkg);
      if (!r.ok) toast(r.error);
    } finally {
      installBusyRef.current.delete(pkg);
    }
  }

  async function uninstallAndroid(pkg: string) {
    if (!window.confirm(`卸载 ${pkg}？已安装的组件会被删除。`)) return;
    setBusyPkg(pkg);
    setError('');
    const r = await api.sdkUninstall(pkg);
    setBusyPkg('');
    if (!r.ok) {
      toast(r.error);
      return;
    }
    toast(`${pkg} 卸载完成`, 'ok');
    reloadInstalled();
    onChanged();
  }

  async function uninstallHarmony(c: HarmonyComponent) {
    if (!window.confirm(`卸载 ${c.name}？该组件将从 SDK 目录删除。`)) return;
    setBusyPkg(c.dir);
    setError('');
    const r = await api.harmonyUninstall(c.dir);
    setBusyPkg('');
    if (!r.ok) {
      toast(r.error);
      return;
    }
    toast(`${c.name} 卸载完成`, 'ok');
    onChanged();
  }

  async function downloadHosImage(g: HosImageGroup, rect: DOMRect) {
    flyToDownloads(rect);
    setError('');
    const start = () => api.hosDownloadImage(g.deviceType, g.osVersion);
    let r = await start();
    if (r.ok && r.data.needLicense) {
      if (!window.confirm('下载 HarmonyOS 系统镜像需先接受华为软件服务协议。确认接受并继续？')) return;
      const acc = await api.hosAcceptLicense();
      if (!acc.ok) {
        toast(acc.error);
        return;
      }
      r = await start();
    }
    if (!r.ok) toast(r.error);
  }

  async function uninstallHosImage(g: HosImageGroup) {
    if (!window.confirm(`卸载镜像 ${g.label} · ${g.osVersion}？将删除已下载的镜像文件。`)) return;
    const key = hosImageKey(g.deviceType, g.osVersion);
    setBusyPkg(key);
    setError('');
    const r = await api.hosUninstallImage(g.deviceType, g.osVersion);
    setBusyPkg('');
    if (!r.ok) {
      toast(r.error);
      return;
    }
    toast(`${g.label} · ${g.osVersion} 卸载完成`, 'ok');
    reloadHosImages();
    onChanged();
  }

  const sysSwitch = (
    <div style={{ marginLeft: 'auto' }}>
      <Segmented
        options={[
          { id: 'android', label: 'Android' },
          { id: 'harmonyos', label: 'HarmonyOS' },
        ]}
        value={system}
        onChange={setSystem}
      />
    </div>
  );

  const q = query.trim().toLowerCase();
  // 派生列表记忆化：搜索框每键触发全面板重渲染，分组/过滤是可缓存的纯计算
  const harmonyShown = useMemo(
    () =>
      q
        ? harmonyComponents.filter((c) => c.name.toLowerCase().includes(q) || (c.version ?? '').toLowerCase().includes(q))
        : harmonyComponents,
    [q, harmonyComponents],
  );
  const hosGroups = useMemo(() => groupHosImages(hosImages ?? []), [hosImages]);
  const hosInstalled = hosGroups.filter((g) => g.downloaded);
  const hosAvailable = hosGroups.filter((g) => !g.downloaded);
  const familyOptions = HOS_IMAGE_FAMILIES.filter((f) => hosGroups.some((g) => g.family === f.id));
  const activeFamily = familyOptions.some((f) => f.id === hosFamily)
    ? hosFamily
    : (familyOptions[0]?.id ?? 'phone');
  const matchesHosQuery = (g: HosImageGroup) =>
    !q ||
    `${g.label} ${hosSeries(g.osVersion)} ${g.osVersion} ${g.softwareVersion ?? ''}`
      .toLowerCase()
      .includes(q);
  const hosShown = (list: HosImageGroup[]) =>
    list.filter((g) => g.family === activeFamily).filter(matchesHosQuery);
  const imageDesc = (g: HosImageGroup) =>
    `${g.osVersion}${g.softwareVersion ? ` · ${g.softwareVersion}` : ''}`;

  function hosImageBtn(g: HosImageGroup) {
    const key = hosImageKey(g.deviceType, g.osVersion);
    const st = dl[key];
    const busy = !!st && (st.state === 'downloading' || st.state === 'queued');
    return (
      <button
        className="btn btn-sm btn-primary"
        disabled={busy}
        onClick={(ev) => void downloadHosImage(g, ev.currentTarget.getBoundingClientRect())}
      >
        {!st ? '安装' : st.state === 'queued' ? '排队中' : st.percent > 0 ? `${st.percent}%` : '安装中'}
      </button>
    );
  }

  function installBtn(pkg: string) {
    const st = dl[pkg];
    const busy = !!st && (st.state === 'downloading' || st.state === 'queued');
    return (
      <button
        className="btn btn-sm btn-primary"
        disabled={busy}
        onClick={(ev) => install(pkg, ev.currentTarget.getBoundingClientRect())}
      >
        {!st ? '安装' : st.state === 'queued' ? '排队中' : st.percent > 0 ? `${st.percent}%` : '安装中'}
      </button>
    );
  }

  if (system === 'harmonyos') {
    return (
      <div>
        <div className="sdk-tabs">
          <div className={`sdk-tab${tab === 'available' ? ' on' : ''}`} onClick={() => setTab('available')}>
            可安装
          </div>
          <div className={`sdk-tab${tab === 'installed' ? ' on' : ''}`} onClick={() => setTab('installed')}>
            已安装 {env?.harmony ? `(${harmonyComponents.length + hosInstalled.length})` : ''}
          </div>
          {sysSwitch}
        </div>
        <div className={tab === 'available' && familyOptions.length > 0 ? 'sdk-filter-row' : undefined}>
          <input
            className="sdk-search"
            placeholder="搜索组件或版本"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {tab === 'available' && familyOptions.length > 0 && (
            <Select
              value={activeFamily}
              options={familyOptions.map((f) => ({ value: f.id, label: f.label }))}
              onChange={setHosFamily}
            />
          )}
        </div>
        <div className="sdk-list">
          {!env?.harmony && (
            <div className="empty">
              未检测到 HarmonyOS SDK
              <div className="empty-actions">
                {onPickFolder && (
                  <button className="btn btn-sm" onClick={onPickFolder}>
                    选择已有文件夹
                  </button>
                )}
                {onOpenDownload &&
                  (huaweiIn === false ? (
                    <button className="btn btn-sm btn-primary" onClick={onOpenDownload}>
                      登录华为账号下载
                    </button>
                  ) : (
                    <button
                      className="btn btn-sm btn-primary"
                      title={huaweiIn === null ? '正在查询登录状态' : '后台获取官方下载地址，完成后自动解压落位'}
                      onClick={onOpenDownload}
                    >
                      {huaweiIn === null ? '查询登录状态…' : '下载并自动落位'}
                    </button>
                  ))}
                <button className="btn btn-sm" disabled={importingZip} onClick={() => void importDownloadedZip()}>
                  {importingZip ? '导入中…' : '导入已下载的压缩包'}
                </button>
              </div>
            </div>
          )}
          {env?.harmony && tab === 'installed' && hosImages === null && (
            <div className="empty">
              <span className="spinner" />
            </div>
          )}
          {env?.harmony &&
            tab === 'installed' &&
            hosImages !== null &&
            harmonyComponents.length === 0 &&
            hosInstalled.length === 0 && <div className="empty">没有检测到组件</div>}
          {env?.harmony && tab === 'available' && hosImages === null && (
            <div className="empty">
              <span className="spinner" />
            </div>
          )}
          {env?.harmony && tab === 'available' && hosImages !== null && (
            <>
              {hosShown(hosAvailable).map((g) => (
                <div key={`${g.family}|${g.osVersion}`} className="img-row">
                  <div className="sdk-pkg">
                    <span className="mono">
                      {g.label} · {hosSeries(g.osVersion)}
                    </span>
                    <span className="sdk-desc">{imageDesc(g)}</span>
                  </div>
                  {hosImageBtn(g)}
                </div>
              ))}
              {hosShown(hosAvailable).length === 0 && (
                <div className="empty">{q ? '没有匹配的组件' : '没有可安装的镜像'}</div>
              )}
            </>
          )}
          {env?.harmony &&
            tab === 'installed' &&
            harmonyShown.map((c) => (
              <div key={c.dir} className="img-row" title={c.dir}>
                <div className="sdk-pkg">
                  <span className="mono">{c.name}</span>
                  <span className="sdk-desc">{c.version ?? c.dir}</span>
                </div>
                <button className="btn btn-sm btn-danger" disabled={busyPkg === c.dir} onClick={() => uninstallHarmony(c)}>
                  {busyPkg === c.dir ? '卸载中' : '卸载'}
                </button>
              </div>
            ))}
          {env?.harmony &&
            tab === 'installed' &&
            hosInstalled.filter(matchesHosQuery).map((g) => {
              const key = hosImageKey(g.deviceType, g.osVersion);
              return (
                <div key={key} className="img-row">
                  <div className="sdk-pkg">
                    <span className="mono">
                      {g.label} · {hosSeries(g.osVersion)}
                    </span>
                    <span className="sdk-desc">{imageDesc(g)}</span>
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busyPkg === key}
                    onClick={() => uninstallHosImage(g)}
                  >
                    {busyPkg === key ? '卸载中' : '卸载'}
                  </button>
                </div>
              );
            })}
          {error && <div className="error-line" style={{ border: 'none' }}>{error}</div>}
        </div>
      </div>
    );
  }

  const list = (tab === 'installed' ? installed : available) ?? [];
  const shown = useMemo(
    () => (q ? list.filter((e) => e.pkg.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q)) : list),
    [q, list],
  );

  return (
    <div>
      <div className="sdk-tabs">
        <div className={`sdk-tab${tab === 'available' ? ' on' : ''}`} onClick={() => setTab('available')}>
          可安装 {available ? `(${available.length})` : ''}
        </div>
        <div className={`sdk-tab${tab === 'installed' ? ' on' : ''}`} onClick={() => setTab('installed')}>
          已安装 {installed ? `(${installed.length})` : ''}
        </div>
        {sysSwitch}
      </div>
      <input
        className="sdk-search"
        placeholder="搜索包名或描述"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      <div className="sdk-list">
        {tab === 'installed' && installed === null && (
          <div className="empty">
            <span className="spinner" />
          </div>
        )}
        {tab === 'available' && loading && (
          <div className="empty">
            <span className="spinner" /> 正在从仓库获取列表…
          </div>
        )}
        {error && <div className="error-line" style={{ border: 'none' }}>{error}</div>}
        {!loading && !error && shown.length === 0 && <div className="empty">没有匹配的组件</div>}
        {shown.map((e) => (
          <div key={e.pkg} className="img-row">
            <div className="sdk-pkg">
              <span className="mono">{e.pkg}</span>
              <span className="sdk-desc">
                {e.desc} {e.version && `· ${e.version}`}
              </span>
            </div>
            {tab === 'installed' ? (
              <button className="btn btn-sm btn-danger" disabled={busyPkg === e.pkg} onClick={() => uninstallAndroid(e.pkg)}>
                {busyPkg === e.pkg ? '卸载中' : '卸载'}
              </button>
            ) : (
              installBtn(e.pkg)
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
