import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { renderPill } from '../pill/pill.ts';
import { renderLocationPanel } from '../pill/locationPanel.ts';
import './app.css';

// 药丸窗口与定位面板复用同一入口，以 hash 路由区分
if (location.hash.startsWith('#pill')) {
  renderPill();
} else if (location.hash.startsWith('#locpanel')) {
  renderLocationPanel();
} else {
  createRoot(document.getElementById('root')!).render(<App />);
}
