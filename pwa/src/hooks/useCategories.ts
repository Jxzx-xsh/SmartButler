import { useQuery } from '@tanstack/react-query';
import { categoriesApi } from '../api/client';

/** 分类列表查询。分类不常变，staleTime 设长一些减少请求。 */
export function useCategoriesQuery() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => categoriesApi.list(),
    staleTime: 5 * 60 * 1000,
  });
}
