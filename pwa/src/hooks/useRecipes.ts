import { useQuery } from '@tanstack/react-query';
import { recipesApi } from '../api/client';

/**
 * 食谱推荐查询。
 *
 * 本地模型推理较慢，采用按钮触发式：enabled:false 不自动跑，由 UI 调 refetch()
 * 手动触发；retry:false 避免对慢推理反复重试。
 */
export function useRecipeRecommend(days?: number) {
  return useQuery({
    queryKey: ['recipes', days ?? null],
    queryFn: () => recipesApi.recommend(days),
    enabled: false,
    retry: false,
  });
}
