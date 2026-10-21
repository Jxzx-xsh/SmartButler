import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './styles/global.css';

// 注册 Service Worker（autoUpdate）。
// 检测到新版本（onNeedRefresh）时自动让新 SW 接管并刷新一次，无需用户手动清缓存——
// 场景为家用局域网 PWA。防无限刷新：配合 workbox 的 skipWaiting+clientsClaim，
// reload 后新 SW 已 active、不再进 waiting，不会再次触发 onNeedRefresh；
// 另加 sessionStorage 一次性守卫作兜底，杜绝异常情况下的刷新循环。
const SW_UPDATED_FLAG = 'sb-sw-updated';
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // 一次性守卫：若本会话已自动更新过，则不再触发刷新。
    if (sessionStorage.getItem(SW_UPDATED_FLAG)) {
      return;
    }
    sessionStorage.setItem(SW_UPDATED_FLAG, '1');
    // 让新版本 SW 接管并自动 reload 页面，加载新版本。
    void updateSW(true);
  },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('找不到挂载节点 #root');
}

// createRoot(#root).render() 会接管 #root 的内容，替换掉 index.html 内联的启动占位。
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

// 保险起见：挂载后主动移除启动占位节点与其内联样式，避免极端时序下占位残留。
requestAnimationFrame(() => {
  document.getElementById('app-splash')?.remove();
  document.getElementById('splash-style')?.remove();
});
