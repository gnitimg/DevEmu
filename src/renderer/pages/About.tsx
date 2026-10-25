import logoUrl from '../../../assets/icon.png';
import { api } from '../api.ts';

/** 关于页：logo、使用说明、使用条款、开源协议、开发者、版本更新 */
export function About() {
  return (
    <div className="about">
      <div className="about-hero">
        <img className="about-logo" src={logoUrl} alt="DevEmu" draggable={false} />
        <div className="about-name">DevEmu</div>
        <div className="about-ver mono">v{__APP_VERSION__}</div>
      </div>
      <div className="section">
        <div className="section-head">
          <h2 className="section-title">使用说明</h2>
        </div>
        <ol className="about-list">
          <li>新建项目，在项目中“新建虚拟机”：型号与系统级联选择，高级配置留空即用推荐值</li>
          <li>启动虚拟机，等待状态变为“运行中”；窗口可拖动，位置不会被拉回</li>
          <li>设备详情页“测试的应用”导入 APK：设备运行时导入即自动安装；设备启动完成后自动补装库中全部应用</li>
          <li>测试记录（结果 / 截图 / logcat）在设备详情下方按项目或设备池归档</li>
          <li>SDK 组件、镜像、下载与限速在设置和下载管理中配置</li>
        </ol>
      </div>
      <div className="section">
        <div className="section-head">
          <h2 className="section-title">使用条款</h2>
        </div>
        <ul className="about-list">
          <li>本软件按“现状”提供，仅供开发与测试用途</li>
          <li>不对虚拟机、APK 与测试数据的丢失承担责任，重要数据请自行备份</li>
          <li>使用 Android SDK、HarmonyOS SDK 等第三方组件须遵守其各自条款</li>
        </ul>
      </div>
      <div className="section">
        <div className="section-head">
          <h2 className="section-title">开源协议</h2>
        </div>
        <div className="about-body">
          <p>本项目以 MIT 协议开源，协议全文见仓库根目录 LICENSE。</p>
          <p>主要依赖 Electron、React、Vite 等，分别遵循其开源协议。</p>
        </div>
      </div>
      <div className="section">
        <div className="section-head">
          <h2 className="section-title">开发者</h2>
        </div>
        <div className="about-body">
          <p>
            gnitimg
            <button className="link-btn mono about-repo" onClick={() => void api.openUrl('https://github.com/gnitimg/DevEmu')}>
              github.com/gnitimg/DevEmu
            </button>
          </p>
        </div>
      </div>
      <div className="section">
        <div className="section-head">
          <h2 className="section-title">版本更新</h2>
        </div>
        <ul className="about-list">
          <li>
            <span className="mono">0.1.0</span>
            <span className="about-log">项目与设备池双模式、SDK 全生命周期管理、APK 导入与自动补装、下载管理与真实限速、自绘标题栏、HarmonyOS SDK 管理</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
