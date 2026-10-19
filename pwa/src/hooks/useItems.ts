import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { itemsApi } from '../api/client';
import type {
  ConsumeBody,
  CreateItemBody,
  ListItemsParams,
  UpdateItemBody,
} from '../api/types';

/** 物品列表查询（按分类/位置/确认态过滤）。 */
export function useItemsQuery(params?: ListItemsParams) {
  return useQuery({
    queryKey: ['items', params ?? {}],
    queryFn: () => itemsApi.list(params),
  });
}

/** 到期看板查询（N 天内含已过期，后端已按到期日升序）。 */
export function useExpiringQuery(days: number) {
  return useQuery({
    queryKey: ['expiring', days],
    queryFn: () => itemsApi.listExpiring(days),
  });
}

/** 增删改成功后失效看板与列表缓存，让所有视图自动刷新。 */
function useInvalidateItems() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['items'] });
    void queryClient.invalidateQueries({ queryKey: ['expiring'] });
  };
}

/** 创建物品。 */
export function useCreateItem() {
  const invalidate = useInvalidateItems();
  return useMutation({
    mutationFn: (body: CreateItemBody) => itemsApi.create(body),
    onSuccess: invalidate,
  });
}

/** 更新物品。 */
export function useUpdateItem() {
  const invalidate = useInvalidateItems();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: UpdateItemBody }) =>
      itemsApi.update(id, body),
    onSuccess: invalidate,
  });
}

/** 删除物品。 */
export function useDeleteItem() {
  const invalidate = useInvalidateItems();
  return useMutation({
    mutationFn: (id: number) => itemsApi.remove(id),
    onSuccess: invalidate,
  });
}

/** 登记消耗 / 用完：减库存或移除物品，成功后刷新列表与看板。 */
export function useConsumeItem() {
  const invalidate = useInvalidateItems();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body?: ConsumeBody }) =>
      itemsApi.consume(id, body),
    onSuccess: invalidate,
  });
}
