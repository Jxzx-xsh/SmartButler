import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { recipesApi } from '../api/client';
import type { SaveRecipeBody } from '../api/types';

/** 已收藏食谱列表查询。 */
export function useSavedRecipes() {
  return useQuery({
    queryKey: ['saved-recipes'],
    queryFn: () => recipesApi.listSaved(),
  });
}

/** 收藏一道食谱，成功后失效收藏列表缓存自动刷新。 */
export function useSaveRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveRecipeBody) => recipesApi.saveRecipe(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-recipes'] });
    },
  });
}

/** 删除一条收藏，成功后失效收藏列表缓存自动刷新。 */
export function useRemoveSavedRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => recipesApi.removeSaved(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['saved-recipes'] });
    },
  });
}
