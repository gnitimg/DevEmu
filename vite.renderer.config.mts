import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** 生产构建注入 CSP meta：apply:'build' 使 dev server/HMR 完全不受影响。
 *  img-src https: 供定位面板 OSM/ArcGIS 瓦片；connect-src 放行 nominatim 地点
 *  搜索；style unsafe-inline 供定位面板动态样式与 React 内联样式属性。 */
const cspMeta = (): Plugin => ({
  name: 'devemu-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; connect-src 'self' https://nominatim.openstreetmap.org; base-uri 'none'; object-src 'none'",
      },
      injectTo: 'head-prepend',
    },
  ],
});

export default defineConfig({
  plugins: [react(), cspMeta()],
});
