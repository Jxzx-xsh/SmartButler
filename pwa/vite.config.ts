import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  // SmartButler 前端固定端口 8821（后端为 8820），避开 3000/5173 等常见默认端口的冲突。
  // host 开启便于局域网/手机访问；strictPort 确保端口被占时直接报错而非静默换端口。
  server: {
    port: 8821,
    host: true,
    strictPort: true,
  },
  preview: {
    port: 8821,
    host: true,
    strictPort: true,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'icon-192.png',
        'icon-512.png',
        'icon-512-maskable.png',
        'apple-touch-icon.png',
        'favicon.svg',
        'favicon-32.png',
      ],
      manifest: {
        name: 'SmartButler 家庭管家',
        short_name: 'SmartButler',
        description: '家庭食材/物品管理与到期提醒',
        lang: 'zh-CN',
        theme_color: '#0FB8C9',
        background_color: '#F2F8FA',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // 仅预缓存静态资源；不对 /api 做运行时缓存，保证数据实时。
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
      },
    }),
  ],
});
