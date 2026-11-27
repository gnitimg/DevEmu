import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { renderPill } from '../pill/pill.ts';
import { renderLocationPanel } from '../pill/locationPanel.ts';
import { renderCapturePage } from '../capture/capturePage.ts';
import './app.css';

// 药丸窗口、定位面板与录屏工作窗复用同一入口，以 hash 路由区分
if (location.hash.startsWith('#pill')) {
  renderPill();
} else if (location.hash.startsWith('#locpanel')) {
  renderLocationPanel();
} else if (location.hash.startsWith('#capture')) {
  renderCapturePage();
} else {
  createRoot(document.getElementById('root')!).render(<App />);
}
