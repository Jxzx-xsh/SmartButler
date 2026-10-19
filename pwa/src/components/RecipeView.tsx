/**
 * 食谱页：按钮触发本地模型推荐 2-4 道家常菜，展示每道菜用料/缺料/步骤/备注。
 *
 * 设计要点：
 * - 触发式：顶部「推荐食谱」按钮调 query.refetch()，不自动跑（本地推理较慢）。
 * - 加载态：显式提示「正在思考…（本地模型推理需几秒到几十秒）」。
 * - 错误态：复用 StatusView + ApiError.message，LM Studio 未开时后端 503 友好提示直接呈现。
 * - 展示：每道菜一张卡片，中文、移动端友好（纵向堆叠）。
 *
 * 样式用 CSS Modules，跟随现有组件风格。
 */

import type { Recipe } from '../api/types';
import { useRecipeRecommend } from '../hooks/useRecipes';
import { StatusView } from './StatusView';
import styles from './RecipeView.module.css';

/** 单道菜卡片。 */
function RecipeCard({ recipe }: { recipe: Recipe }) {
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
    </article>
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
    </section>
  );
}
