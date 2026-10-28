/**
 * 药丸窗口渲染层：模拟器右侧的竖向胶囊操作条。
 * 通过 hash 路由挂载（#pill?serial=emulator-5554），复用主应用的 preload 桥。
 * 透明窗口 + CSS 胶囊圆角，深色玻璃质感、描边图标。
 */

type PillActionId = 'power' | 'powerLong' | 'volup' | 'voldown' | 'screenshot' | 'rotate' | 'back' | 'home' | 'recents';

interface PillBridge {
  pillAction: (serial: string, action: PillActionId) => Promise<unknown>;
  pillMoveStart: (serial: string) => Promise<unknown>;
  pillOpenLocation: (serial: string) => Promise<unknown>;
}

function bridge(): PillBridge {
  return (window as unknown as { devemu: PillBridge }).devemu;
}

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
// 竖排圆形按钮（上→下）：电源 / 音量+ / 音量- / 截图 / 旋转 / 定位 / 返回 / 桌面 / 多任务
type PillButton = { id: PillActionId | 'location'; title: string; svg: string };
const BUTTONS: PillButton[] = [
  {
    id: 'power',
    title: '电源',
    svg: `<path d="M12 3v8" ${STROKE}/><path d="M6.6 6.4a7.6 7.6 0 1 0 10.8 0" ${STROKE}/>`,
  },
  {
    id: 'volup',
    title: '音量+',
    svg: `<path d="M4.5 9.5v5h3.2l4.3 3.6V5.9L7.7 9.5H4.5z" ${STROKE}/><path d="M16 9.2a4.6 4.6 0 0 1 0 5.6" ${STROKE}/>`,
  },
  {
    id: 'voldown',
    title: '音量-',
    svg: `<path d="M4.5 9.5v5h3.2l4.3 3.6V5.9L7.7 9.5H4.5z" ${STROKE}/><path d="M16.5 10.4a3.2 3.2 0 0 1 0 3.2" ${STROKE}/>`,
  },
  {
    id: 'screenshot',
    title: '截图',
    svg: `<rect x="3.5" y="7" width="17" height="12.5" rx="2.6" ${STROKE}/><circle cx="12" cy="13.2" r="3.4" ${STROKE}/><path d="M9.2 7l1.4-2.3h2.8L14.8 7" ${STROKE}/>`,
  },
  {
    id: 'rotate',
    title: '旋转屏幕',
    svg: `<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" ${STROKE}/><path d="M19.5 3.8v3.4h-3.4" ${STROKE}/>`,
  },
  {
    id: 'location',
    title: '虚拟定位',
    svg: `<path d="M12 21s-6.2-5.4-6.2-10a6.2 6.2 0 1 1 12.4 0c0 4.6-6.2 10-6.2 10z" ${STROKE}/><circle cx="12" cy="10.8" r="2.3" ${STROKE}/>`,
  },
  {
    id: 'back',
    title: '返回',
    svg: `<path d="M14.5 5.5 8 12l6.5 6.5" ${STROKE}/>`,
  },
  {
    id: 'home',
    title: '桌面',
    svg: `<circle cx="12" cy="12" r="7.2" ${STROKE}/>`,
  },
  {
    id: 'recents',
    title: '多任务',
    svg: `<rect x="5.5" y="5.5" width="13" height="13" rx="2.4" ${STROKE}/>`,
  },
];

const CSS = `
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
/* 主应用挂载点在药丸窗口里不渲染，但 height:100% 会占一整屏把内容推出视口 */
body.pill-body #root { display: none; }
body.pill-body { user-select: none; font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif; }
.pill-shell {
  height: calc(100% - 16px);
  margin: 8px 4px;
  border-radius: 999px;
  background: rgba(16, 18, 24, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.10);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  padding: 14px 0 12px;
  box-sizing: border-box;
}
.pill-col {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pill-btn {
  width: 37px;
  height: 37px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: rgba(255, 255, 255, 0.74);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.16s ease, color 0.16s ease, transform 0.08s ease;
}
.pill-btn svg { width: 19px; height: 19px; pointer-events: none; display: block; }
.pill-btn:hover { background: rgba(255, 255, 255, 0.10); color: #ffffff; }
.pill-btn:active { transform: scale(0.9); background: rgba(255, 255, 255, 0.16); }
.pill-btn.busy { color: #8ab4ff; background: rgba(138, 180, 255, 0.14); }
/* 长按电源：3 秒内背景渐红，松开提前取消 */
.pill-btn.power-pressing {
  color: #ff7b72;
  background: rgba(255, 123, 114, 0.22);
  transition: background 3s linear, color 3s linear;
}
.pill-grip {
  width: 37px;
  height: 26px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  transition: background 0.16s ease;
}
.pill-grip:hover { background: rgba(255, 255, 255, 0.08); }
.pill-grip:active { cursor: grabbing; }
.pill-grip span {
  width: 16px;
  height: 3.5px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.34);
  transition: background 0.16s ease;
}
.pill-grip:hover span { background: rgba(255, 255, 255, 0.6); }
`;

/** 挂载药丸 UI（入口在 hash 以 #pill 开头时调用） */
export function renderPill(): void {
  const params = new URLSearchParams(location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : '');
  const serial = params.get('serial') ?? '';

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const shell = document.createElement('div');
  shell.className = 'pill-shell';

  const col = document.createElement('div');
  col.className = 'pill-col';
  for (const b of BUTTONS) {
    const btn = document.createElement('button');
    btn.className = 'pill-btn';
    btn.title = b.id === 'power' ? '电源（长按 3 秒关机）' : b.title;
    btn.setAttribute('aria-label', b.title);
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${b.svg}</svg>`;

    if (b.id === 'power') {
      // 长按 3 秒触发关机；短按为息屏/亮屏切换
      let timer: number | undefined;
      let longFired = false;
      const fire = (id: PillActionId) => {
        console.log('[pill] fire', id);
        btn.classList.add('busy');
        void bridge()
          .pillAction(serial, id)
          .catch(() => undefined)
          .finally(() => {
            setTimeout(() => btn.classList.remove('busy'), 300);
          });
      };
      btn.addEventListener('pointerdown', (e) => {
        console.log('[pill] power pointerdown, button =', e.button);
        if (e.button !== 0) return;
        longFired = false;
        btn.classList.add('power-pressing');
        timer = window.setTimeout(() => {
          longFired = true;
          btn.classList.remove('power-pressing');
          fire('powerLong');
        }, 3000);
      });
      const cancelPress = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        btn.classList.remove('power-pressing');
      };
      btn.addEventListener('pointerup', () => {
        const wasLong = longFired;
        cancelPress();
        if (!wasLong) fire('power');
      });
      btn.addEventListener('pointerleave', () => {
        if (!longFired) cancelPress();
      });
    } else if (b.id === 'location') {
      btn.addEventListener('click', () => {
        void bridge()
          .pillOpenLocation(serial)
          .catch(() => undefined);
      });
    } else {
      const id = b.id;
      btn.addEventListener('click', () => {
        btn.classList.add('busy');
        void bridge()
          .pillAction(serial, id)
          .catch(() => undefined)
          .finally(() => {
            setTimeout(() => btn.classList.remove('busy'), 300);
          });
      });
    }
    col.appendChild(btn);
  }
  shell.appendChild(col);

  const grip = document.createElement('div');
  grip.className = 'pill-grip';
  grip.title = '按住拖动，移动模拟器与药丸';
  grip.innerHTML = '<span></span>';
  grip.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    void bridge()
      .pillMoveStart(serial)
      .catch(() => undefined);
  });
  shell.appendChild(grip);

  document.body.className = 'pill-body';
  document.body.appendChild(shell);
}
