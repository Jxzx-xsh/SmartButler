import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vite.dev/config/
export default defineConfig({
  // SmartButler 前端固定端口 8821（后端为 8820），避开 3000/5173 等常见默认端口的冲突。
  // host 开启便于局域网/手机访问；strictPort 确保端口被占时直接报错而非静默换端口。
  // allowedHosts 放行自定义域名访问（Vite 默认仅允许 localhost/局域网 IP，对域名会拦截）：
  //   '.xushihu.com' 覆盖该域名的所有子域；如需放行任意域名可改为 true（仅限受信内网环境）。
  server: {
    port: 8821,
    host: true,
    strictPort: true,
    allowedHosts: ['.xushihu.com', 'localhost'],
    // 把 /api 请求代理到本机后端 8820：前端走相对路径 /api，经此转发到后端。
    // 这样通过内网穿透只需暴露前端一个入口，后端无需单独对外暴露。
    // ws:true 支持 WebSocket（HA 事件等）；MJPEG 流/文件上传走 /api 也一并转发。
    proxy: {
      '/api': {
        target: 'http://localhost:8820',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  preview: {
    port: 8821,
    host: true,
    strictPort: true,
    allowedHosts: ['.xushihu.com', 'localhost'],
    proxy: {
      '/api': {
        target: 'http://localhost:8820',
        changeOrigin: true,
        ws: true,
      },
    },
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
