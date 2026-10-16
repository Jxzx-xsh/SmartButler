/**
 * 采集网关相关的 TanStack Query hooks。
 *
 * 职责：把 captureApi 的状态轮询、启动/停止、通话上传封装成 React Query 的
 * query/mutation，供 MonitorView 消费。范式对齐 hooks/useItems.ts——查询用
 * useQuery、写操作用 useMutation 并在成功后失效相关缓存触发状态刷新。
 *
 * 状态查询走 refetchInterval 轮询（2s），以反映后端采集状态机的实时变化；
 * 启动/停止成功后主动失效 ['capture-status'] 让面板立即跟上，而非等下一轮轮询。
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { captureApi } from '../api/client';

/** 采集状态查询：每 2 秒轮询一次 /api/capture/status。 */
export function useCaptureStatus() {
  return useQuery({
    queryKey: ['capture-status'],
    queryFn: captureApi.status,
    refetchInterval: 2000,
  });
}

/** 启动采集成功后失效状态缓存，让面板立即刷新。 */
function useInvalidateCapture() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['capture-status'] });
  };
}

/** 启动采集（切源 + 启动）。 */
export function useStartCapture() {
  const invalidate = useInvalidateCapture();
  return useMutation({
    mutationFn: (body: { url: string; fps?: number }) => captureApi.start(body),
    onSuccess: invalidate,
  });
}

/** 停止采集。 */
export function useStopCapture() {
  const invalidate = useInvalidateCapture();
  return useMutation({
    mutationFn: () => captureApi.stop(),
    onSuccess: invalidate,
  });
}

/** 上传通话录音（方案 A 仅上行留存）。 */
export function useTalk() {
  return useMutation({
    mutationFn: (blob: Blob) => captureApi.talk(blob),
  });
}
