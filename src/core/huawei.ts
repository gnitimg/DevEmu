import { BrowserWindow, session } from 'electron';

/**
 * 华为开发者账号登录会话。
 *
 * 登录使用独立持久分区 persist:huawei，Cookie 随应用保留，供后续直接在主进程
 * 重放下载中心接口。登录成功的标志是 developer.huawei.com 写入的用户 cookie
 * （developer_userdata，历史命名 developer_userinfo，值含 csrftoken）。
 */

const PARTITION = 'persist:huawei';
const LOGIN_SITE = 'https://developer.huawei.com/';
/** 登录标志 cookie 名：两种命名在不同版本的华为登录流程中都出现过 */
const LOGIN_MARKERS = ['developer_userdata', 'developer_userinfo'];
/** cookie 查询超时：分区库被占用/初始化卡住时不让调用方无限等待 */
const PROBE_TIMEOUT_MS = 4000;
/** 登录入口用下载中心页面：未登录访问会自动跳华为账号登录页，登录后原路返回 */
const LOGIN_URL = 'https://developer.huawei.com/consumer/cn/download/command-line-tools-for-hmos';

let loginWin: BrowserWindow | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** 分区里是否存在登录标志 cookie（任一命名、值非空） */
export async function hasHuaweiLogin(): Promise<boolean> {
  try {
    const probe = session.fromPartition(PARTITION).cookies.get({ url: LOGIN_SITE });
    const cookies = await Promise.race([
      probe,
      new Promise<import('electron').Cookie[]>((resolve) => setTimeout(() => resolve([]), PROBE_TIMEOUT_MS)),
    ]);
    return cookies.some((c) => LOGIN_MARKERS.includes(c.name) && c.value.length > 0);
  } catch {
    return false;
  }
}

/** 登录状态翻转时回调（含过期/退出登录），用于向渲染层广播 */
export function watchHuaweiLogin(onChange: (loggedIn: boolean) => void): void {
  let last: boolean | null = null;
  session.fromPartition(PARTITION).cookies.on('changed', () => {
    void hasHuaweiLogin().then((now) => {
      if (last !== null && now !== last) onChange(now);
      last = now;
    });
  });
}

/** 打开登录窗口（重复点击聚焦已有窗口），轮询到登录 cookie 后自动关闭 */
export function openHuaweiLogin(onLogin: () => void): void {
  if (loginWin && !loginWin.isDestroyed()) {
    if (loginWin.isMinimized()) loginWin.restore();
    loginWin.focus();
    return;
  }
  loginWin = new BrowserWindow({
    width: 1080,
    height: 760,
    title: '登录华为账号',
    backgroundColor: '#f6f7f8',
    webPreferences: { partition: PARTITION },
  });
  void loginWin.loadURL(LOGIN_URL);

  const stopPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  pollTimer = setInterval(() => {
    void hasHuaweiLogin().then((loggedIn) => {
      if (!loggedIn) return;
      stopPoll();
      if (loginWin && !loginWin.isDestroyed()) loginWin.close();
      onLogin();
    });
  }, 1500);
  loginWin.on('closed', () => {
    stopPoll();
    loginWin = null;
  });
}
