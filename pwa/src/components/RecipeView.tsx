/**
 * 食谱页：按钮触发本地模型推荐 2-4 道家常菜，展示每道菜用料/缺料/步骤/备注；
 * 并在下方提供「我的收藏」分区，收藏喜欢的菜、支持二次确认删除。
 *
 * 设计要点：
 * - 触发式：顶部「推荐食谱」按钮调 query.refetch()，不自动跑（本地推理较慢）。
 * - 加载态：显式提示「正在思考…（本地模型推理需几秒到几十秒）」。
 * - 错误态：复用 StatusView + ApiError.message，LM Studio 未开时后端 503 友好提示直接呈现。
 * - 收藏：推荐卡片带「收藏」按钮，收藏成功短暂反馈「已收藏」；收藏并入本食谱 tab，不新增顶层 tab。
 * - 我的收藏：useSavedRecipes 取数，StatusView 处理 loading/error/空态，删除走 ConfirmDialog 二次确认。
 * - 展示：每道菜一张卡片，中文、移动端友好（纵向堆叠）。
 *
 * 样式用 CSS Modules，跟随现有组件风格。
 */

import { useState } from 'react';
import type { Recipe, SavedRecipe } from '../api/types';
import {
  useRecipeRecommend,
  useRemoveSavedRecipe,
  useSaveRecipe,
  useSavedRecipes,
} from '../hooks/useRecipes';
import { formatDate } from '../lib/date';
import { ConfirmDialog } from './ConfirmDialog';
import { StatusView } from './StatusView';
import styles from './RecipeView.module.css';

/** 单道推荐菜卡片，带「收藏」按钮。 */
function RecipeCard({ recipe }: { recipe: Recipe }) {
  const save = useSaveRecipe();
  // 收藏成功后短暂切换按钮文案为「已收藏」
  const [saved, setSaved] = useState(false);

  const onSave = () => {
    save.mutate(
      {
        name: recipe.name,
        usedItems: recipe.usedItems,
        missingItems: recipe.missingItems,
        steps: recipe.steps,
        note: recipe.note,
      },
      {
        onSuccess: () => {
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  };

  return (
    <article className={styles.card}>
      <h3 className={styles.name}>{recipe.name}</h3>

      {recipe.usedItems.length > 0 && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>用料</span>
          <span className={styles.tags}>
            {recipe.usedItems.map((item) => (
              <span key={item} className={styles.tag}>
                {item}
              </span>
            ))}
          </span>
        </div>
      )}

      {recipe.missingItems && recipe.missingItems.length > 0 && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>需购</span>
          <span className={styles.tags}>
            {recipe.missingItems.map((item) => (
              <span key={item} className={`${styles.tag} ${styles.tagMissing}`}>
                {item}
              </span>
            ))}
          </span>
        </div>
      )}

      {recipe.steps && recipe.steps.length > 0 && (
        <ol className={styles.steps}>
          {recipe.steps.map((step, idx) => (
            <li key={idx}>{step}</li>
          ))}
        </ol>
      )}

      {recipe.note && <p className={styles.note}>{recipe.note}</p>}

      <button
        type="button"
        className={styles.saveBtn}
        onClick={onSave}
        disabled={save.isPending || saved}
      >
        {save.isPending ? '收藏中…' : saved ? '已收藏' : '收藏'}
      </button>
    </article>
  );
}

/** 单条已收藏菜卡片，带删除按钮。 */
function SavedRecipeCard({
  recipe,
  onDelete,
}: {
  recipe: SavedRecipe;
  onDelete: (recipe: SavedRecipe) => void;
}) {
  return (
    <article className={styles.card}>
      <h3 className={styles.name}>{recipe.name}</h3>

      {recipe.usedItems.length > 0 && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>用料</span>
          <span className={styles.tags}>
            {recipe.usedItems.map((item) => (
              <span key={item} className={styles.tag}>
                {item}
              </span>
            ))}
          </span>
        </div>
      )}

      {recipe.missingItems && recipe.missingItems.length > 0 && (
        <div className={styles.row}>
          <span className={styles.rowLabel}>需购</span>
          <span className={styles.tags}>
            {recipe.missingItems.map((item) => (
              <span key={item} className={`${styles.tag} ${styles.tagMissing}`}>
                {item}
              </span>
            ))}
          </span>
        </div>
      )}

      {recipe.steps && recipe.steps.length > 0 && (
        <ol className={styles.steps}>
          {recipe.steps.map((step, idx) => (
            <li key={idx}>{step}</li>
          ))}
        </ol>
      )}

      {recipe.note && <p className={styles.note}>{recipe.note}</p>}

      <p className={styles.savedTime}>收藏于 {formatDate(recipe.createdAt)}</p>

      <button
        type="button"
        className={styles.deleteBtn}
        onClick={() => onDelete(recipe)}
      >
        删除
      </button>
    </article>
  );
}

/** 「我的收藏」分区：取数、空态、删除二次确认。 */
function SavedRecipesSection() {
  const query = useSavedRecipes();
  const remove = useRemoveSavedRecipe();
  const saved = query.data ?? [];
  const [deleteTarget, setDeleteTarget] = useState<SavedRecipe | null>(null);

  const isEmpty = !query.isLoading && !query.error && saved.length === 0;

  const onConfirmDelete = () => {
    if (!deleteTarget) return;
    remove.mutate(deleteTarget.id, {
      onSuccess: () => setDeleteTarget(null),
    });
  };

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>我的收藏</h2>

      <StatusView
        isLoading={query.isLoading}
        error={query.error}
        isEmpty={isEmpty}
        emptyText="还没有收藏，去上面推荐里收藏喜欢的菜吧"
        onRetry={() => void query.refetch()}
      />

      {saved.length > 0 && (
        <div className={styles.list}>
          {saved.map((recipe) => (
            <SavedRecipeCard
              key={recipe.id}
              recipe={recipe}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除收藏"
          content={`确定删除收藏「${deleteTarget.name}」吗？`}
          confirmText="删除"
          busy={remove.isPending}
          onConfirm={onConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

/** 食谱页主体组件。 */
export function RecipeView() {
  const query = useRecipeRecommend();
  const recipes = query.data?.recipes ?? [];
  // 已发起过请求且非加载中、无错误、结果为空时，提示空态
  const isEmpty =
    query.isFetched && !query.isFetching && !query.error && recipes.length === 0;

  return (
    <section className={styles.container}>
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>推荐食谱</h2>

        <div className={styles.header}>
          <p className={styles.intro}>
            根据家里现有食材（临期优先）推荐几道家常菜，由本地模型生成。
          </p>
          <button
            type="button"
            className={styles.recommendBtn}
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {query.isFetching ? '正在思考…' : '推荐食谱'}
          </button>
        </div>

        {query.isFetching && (
          <div className={styles.thinking}>
            正在思考…（本地模型推理需几秒到几十秒）
          </div>
        )}

        {!query.isFetching && (
          <StatusView
            error={query.error}
            isEmpty={isEmpty}
            emptyText="没有推荐结果，换个时间或补充食材后再试"
            onRetry={() => void query.refetch()}
          />
        )}

        {!query.isFetching && recipes.length > 0 && (
          <div className={styles.list}>
            {recipes.map((recipe) => (
              <RecipeCard key={recipe.name} recipe={recipe} />
            ))}
          </div>
        )}
      </div>

      <SavedRecipesSection />
    </section>
  );
}
