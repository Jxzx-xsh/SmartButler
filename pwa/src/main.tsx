import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './styles/global.css';

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
