# 实现计划 — Task 1：核心数据模型与数据库层

> 范围：仅数据模型（drizzle-orm sqlite 表定义）、到期计算纯函数、数据库连接/初始化/种子、数据访问层与 vitest 测试。**不实现 HTTP API / 路由**（那是 Task 2）。全 Node/TypeScript，ESM，严格 TS，代码注释用中文。

## 工程现状（调研结论）
- `backend/package.json`：`"type": "module"`（ESM）。依赖 `better-sqlite3@^11.8.1`、`drizzle-orm@^0.38.4`；devDeps 含 `@types/better-sqlite3`、`@types/node`、`drizzle-kit`、`tsx`、`typescript`、`vitest`。脚本：`db:init`=`tsx src/db/init.ts`、`db:seed`=`tsx src/db/seed.ts`、`test`=`vitest run`、`typecheck`=`tsc -p tsconfig.json --noEmit`、`build`=`tsc`。
- `backend/tsconfig.json`：target ES2022、module ESNext、moduleResolution Bundler、`strict`、`noUncheckedIndexedAccess`、rootDir=src、outDir=dist。
- `backend/src/` 目前为空；无 `node_modules`、无 lockfile、无 CONTRIBUTING/steering 文档。首先需 `npm install`。
- 需按本任务新建全部源文件。

## 关键决策
- **日期存储方式：统一用 Unix 毫秒时间戳整数（`INTEGER`）。** 理由：SQLite 原生无日期类型；整数毫秒比较/排序直接用数值运算，`listExpiringItems` 的区间查询与升序排序最简单且无时区歧义；到期计算（`purchaseDate + shelfLifeDays*86400000`）为纯整数算术，避免字符串解析。此决策必须在 `schema.ts` 顶部用中文注释写明。`purchaseDate/expiryDate/recordedAt/createdAt/updatedAt` 全部为 `integer`（毫秒）。
- **建表方式：`init.ts` 中直接 `CREATE TABLE IF NOT EXISTS`（原生 SQL，经 better-sqlite3 执行）。** 理由：任务优先保证 `db:init`/`db:seed` 真实跑通，直接建表比 drizzle-kit migration 配置更少、确定性更高；**不**新增 `drizzle.config.ts`，不引入计划外流程。表结构必须与 `schema.ts` 字段逐一对应。
- **布尔存储：`confirmed` 用 `integer({ mode: 'boolean' })`**（drizzle 将 0/1 映射为布尔），默认 `true`。
- **枚举：`source`（'manual'|'voice'|'vision'）与 `eventType` 用 `text({ enum: [...] })`** 做 TS 字面量约束，运行期仍存字符串。
- **自增主键：`integer().primaryKey({ autoIncrement: true })`**。
- **drizzle 实例：`drizzle-orm/better-sqlite3` 的 `drizzle(sqlite, { schema })`**；底层 `better-sqlite3` 连接开启 `journal_mode = WAL`。

## 文件职责一览
- `src/db/schema.ts`：四张表（Category / Item / ExpiryRecord / EventLog）的 drizzle 定义 + 顶部日期决策注释 + 导出推断类型（`$inferSelect`/`$inferInsert`）。
- `src/domain/expiry.ts`：到期计算纯函数，不依赖数据库，入参用结构化类型。
- `src/db/client.ts`：创建/导出 drizzle 实例与底层连接；读 `SMARTBUTLER_DB_PATH`，默认 `backend/data/smartbutler.db`，自动建 `data` 目录，开 WAL。
- `src/db/init.ts`：`CREATE TABLE IF NOT EXISTS` 建全部表，可被 `npm run db:init` 跑通。
- `src/db/seed.ts`：插入示例分类与食材（含“两盒牛奶，保质期到下周五”），可被 `npm run db:seed` 跑通。
- `src/db/repository.ts`：物品/到期的数据访问层函数（依赖注入 db 实例以便测试）。
- `src/domain/expiry.test.ts`：到期纯函数单测。
- `src/db/repository.test.ts`：仓储层集成测试（内存 SQLite）。

---

# Implementation Plan

- [ ] 1. 安装依赖，建立可运行基线。
      执行 `npm install` 生成 `node_modules` 与 lockfile；确认 `tsx`/`vitest`/`better-sqlite3`/`drizzle-orm` 可解析。
      Files: 无新增源码（可能生成 `backend/package-lock.json`）
      Verify: 在 `backend/` 运行 `npm install` 成功无错误；`npm run typecheck` 可执行（此时 src 为空，预期通过或仅因无文件而无输出）。

- [ ] 2. 定义 drizzle schema 与四张表，顶部写明日期存储决策（毫秒整数）。
      在 `src/db/schema.ts` 用 `drizzle-orm/sqlite-core` 的 `sqliteTable/integer/text` 定义：
      Category(id autoIncrement 主键, name text 非空 unique, icon text 可空, color text 可空)；
      Item(id, name 非空, quantity integer 默认 1, unit 可空, categoryId integer 可空 外键→category.id, location 可空, purchaseDate integer 可空(毫秒), shelfLifeDays integer 可空, expiryDate integer 可空(毫秒), confirmed integer{mode:'boolean'} 默认 true, source text{enum:['manual','voice','vision']} 默认 'manual', note 可空, createdAt integer 默认当前毫秒, updatedAt integer 默认当前毫秒)；
      ExpiryRecord(id, itemId integer 外键→item.id, eventType text{enum:['expired','consumed','discarded']}, recordedAt integer)；
      EventLog(id, eventType text, payload text(JSON 字符串), source text, createdAt integer 默认当前毫秒)。
      外键用 `.references(() => ...)`；`createdAt/updatedAt` 用 `$defaultFn(() => Date.now())`。导出每张表的 `$inferSelect`/`$inferInsert` 类型别名。全文件中文注释。
      Files: src/db/schema.ts
      Verify: `npm run typecheck` 通过（schema 类型无误）。

- [ ] 3. 实现到期计算纯函数。
      在 `src/domain/expiry.ts` 定义并导出：
      `computeExpiryDate(purchaseDate: number | null, shelfLifeDays: number | null): number | null`（两者皆有效时返回 `purchaseDate + shelfLifeDays * 86_400_000`，否则 null）；
      `daysUntilExpiry(item, now = Date.now()): number | null`（无 expiryDate 返回 null；否则 `Math.ceil((expiryDate - now)/86_400_000)`，已过期为负）；
      `isExpiringWithin(item, days, now = Date.now()): boolean`（含已过期：`d !== null && d <= days`）。
      入参类型用局部结构类型（如 `Pick<Item, 'expiryDate'>` 或自定义接口），**不**导入 db，保证纯函数。日期单位与 schema 一致（毫秒）。全文件中文注释。
      Files: src/domain/expiry.ts
      Verify: `npm run typecheck` 通过。

- [ ] 4. 为到期纯函数编写并通过单测。
      在 `src/domain/expiry.test.ts` 用 vitest 覆盖：`computeExpiryDate`（齐全/缺一/全缺）、`daysUntilExpiry`（未来/今天/已过期/无到期日 → null）、`isExpiringWithin` 边界（恰好第 N 天、已过期为 true、无到期日为 false）。用固定 `now` 时间戳避免时钟抖动。
      Files: src/domain/expiry.test.ts
      Verify: `npx vitest run src/domain/expiry.test.ts` 全部通过。

- [ ] 5. 实现数据库连接与 drizzle 实例（WAL + 可配置路径）。
      在 `src/db/client.ts`：从 `process.env.SMARTBUTLER_DB_PATH` 读文件路径，默认 `backend/data/smartbutler.db`（用 `path`/`url` 解析绝对路径，`fs.mkdirSync(dir, { recursive: true })` 确保 `data` 目录存在）；用 `better-sqlite3` 打开连接并执行 `PRAGMA journal_mode = WAL;`；用 `drizzle-orm/better-sqlite3` 的 `drizzle(sqlite, { schema })` 创建实例。导出 `db`、底层 `sqlite` 连接，以及一个 `createDb(path?)` 工厂函数（供测试传入 `:memory:`）。全文件中文注释。
      Files: src/db/client.ts
      Verify: `npm run typecheck` 通过。

- [ ] 6. 实现建表脚本 `init.ts`（CREATE TABLE IF NOT EXISTS），使 `db:init` 跑通。
      在 `src/db/init.ts` 导出一个 `initSchema(sqlite)` 函数，用原生 SQL `CREATE TABLE IF NOT EXISTS` 建四张表（字段/类型/约束/外键与 schema.ts 完全一致，布尔/枚举存为 INTEGER/TEXT），并在被直接运行时对默认 `client` 连接执行后打印完成日志。表定义顺序满足外键依赖（category、item 在前）。全文件中文注释。
      Files: src/db/init.ts
      Verify: 在 `backend/` 运行 `npm run db:init` 成功；`sqlite3`/脚本确认生成 `data/smartbutler.db` 且含 category/item/expiry_record/event_log 四表（可在脚本结束前查询 `sqlite_master` 打印表名）。

- [ ] 7. 实现数据访问层 repository。
      在 `src/db/repository.ts` 导出以参数接收 db 实例的函数（便于测试注入内存库）：
      `createItem(db, input)`（若未显式给 `expiryDate` 但有 `purchaseDate`+`shelfLifeDays`，调用 `computeExpiryDate` 自动填充；设置 createdAt/updatedAt）；
      `getItem(db, id)`；
      `listItems(db, filter?)`（支持按 `categoryId`/`location` 过滤，用 drizzle `and`/`eq`）；
      `updateItem(db, id, patch)`（更新 updatedAt）；
      `deleteItem(db, id)`；
      `listExpiringItems(db, days, now?)`（返回 `expiryDate` 非空且 `<= now + days*86400000` 的物品，按 `expiryDate` 升序 `asc`）。
      依赖 `schema.ts` 的表与 `expiry.ts` 的 `computeExpiryDate`。全文件中文注释。
      Files: src/db/repository.ts
      Verify: `npm run typecheck` 通过。

- [ ] 8. 为 repository 编写并通过集成测试（内存 SQLite）。
      在 `src/db/repository.test.ts`：每个用例用 `createDb(':memory:')` + `initSchema` 建新库（`beforeEach`），测试：
      createItem 在仅给 purchaseDate+shelfLifeDays 时自动算出正确 expiryDate；
      createItem 显式给 expiryDate 时不被覆盖；
      listItems 按 categoryId 与 location 过滤正确；
      listExpiringItems(days) 只返回 N 天内（含已过期）物品且按到期日升序；无到期日的物品不出现。
      Files: src/db/repository.test.ts
      Verify: `npx vitest run src/db/repository.test.ts` 全部通过。

- [ ] 9. 实现种子脚本 `seed.ts`，使 `db:seed` 跑通。
      在 `src/db/seed.ts`：先确保表存在（调用 `initSchema`），插入 3-4 个分类（如 乳制品/蔬果/日用品）与若干食材，含“两盒牛奶，保质期到下周五”（quantity=2, unit='盒', 用 `computeExpiryDate` 或直接设下周五毫秒），并包含“即将到期”（如 2 天内）与“还早”（如 30 天后）各若干条；用 repository 的 `createItem` 插入以复用自动算到期逻辑。被直接运行时对默认 `client` 执行并打印插入条数。全文件中文注释。
      Files: src/db/seed.ts
      Verify: 在 `backend/` 运行 `npm run db:init && npm run db:seed` 成功；脚本打印插入的分类/食材数量 > 0。

- [ ] 10. 全量验证与 Demo。
      依次运行完整验证链，确认整个数据层可用。
      Files: 无
      Verify: 在 `backend/` 依次运行并全部成功：
      `npm install`；
      `npm run typecheck`（无类型错误）；
      `npm test`（`vitest run`，expiry 与 repository 全部用例通过）；
      `rm -f data/smartbutler.db*` 后 `npm run db:init`（建库建表成功）；
      `npm run db:seed`（插入示例数据成功）；
      Demo：运行一段临时 `tsx` 片段（或扩展 seed 后打印）调用 `listExpiringItems(db, 3)`，确认返回 3 天内到期清单且按到期日升序（例如包含“两盒牛奶”若其在 3 天内）。Demo 后清理临时文件。

## 约束复核（实现者须遵守）
- 全 ESM、严格 TS、遵守 `noUncheckedIndexedAccess`（数组索引结果需判空）；不滥用 `any`。
- 不新增计划外依赖；不实现 HTTP 服务器/路由；不修改 `docs/技术方案.md` 与 `readme.md`。
- 代码注释统一中文。
- 日期全库统一毫秒整数，`schema.ts` 顶部注释说明该决策。

## 已知假设/空缺
- “保质期到下周五”在 seed 中按脚本运行当日起算下一个周五的毫秒时间戳生成（动态计算），以保证每次运行都是“未来的下周五”。
- Category 的 icon/color 字段按“可选”实现为可空 text。
- 未配置 drizzle-kit migration/`drizzle.config.ts`（采用直接建表），符合“优先保证两脚本跑通”的要求。

---

# 实现结果（Task 1 — 第一次迭代）

## 实现文件清单
- `src/db/schema.ts` — 四张表（category/item/expiry_record/event_log）的 drizzle 定义，顶部注释说明日期存储决策；导出 `$inferSelect`/`$inferInsert` 类型与聚合 `schema`。
- `src/domain/expiry.ts` — 纯函数 `computeExpiryDate` / `daysUntilExpiry` / `isExpiringWithin` 与常量 `MS_PER_DAY`，不依赖数据库。
- `src/db/client.ts` — `createDb(path?)` 工厂、默认 `db`/`sqlite` 导出；读 `SMARTBUTLER_DB_PATH`，默认 `backend/data/smartbutler.db`，自动建 data 目录，开 WAL + 外键。
- `src/db/init.ts` — `initSchema(sqlite)` 用 `CREATE TABLE IF NOT EXISTS` 建全部表；直接运行打印表名。
- `src/db/repository.ts` — `createItem`（自动算到期日）/`getItem`/`listItems`（categoryId/location 过滤）/`updateItem`/`deleteItem`/`listExpiringItems(days)`（升序）。
- `src/db/seed.ts` — `seedData(db, now?)` + `nextFriday(now?)`；插入 3 分类 + 5 食材（含“两盒牛奶，保质期到下周五”）。
- `src/domain/expiry.test.ts` — 12 个用例（固定 now）。
- `src/db/repository.test.ts` — 13 个用例（内存库 `:memory:`）。
- `.gitignore` — 忽略 node_modules/dist/data 与 db 文件。

## 关键设计决策
- **日期存储：全库统一 Unix 毫秒时间戳整数（INTEGER）**。SQLite 无原生日期类型，整数毫秒便于区间查询/升序排序且无时区歧义；到期计算为纯整数算术。已在 `schema.ts` 顶部注释写明。
- **建表方式**：`init.ts` 直接 `CREATE TABLE IF NOT EXISTS`，未引入 `drizzle.config.ts`（计划内决策）。
- **布尔/枚举**：`confirmed` 用 `integer({mode:'boolean'})`；`source`/`eventType` 用 `text({enum})`。
- **可测性**：仓储层与 seed 均以参数接收 db 实例，测试注入 `:memory:` 库；`createDb` 工厂支持任意路径。
- **未新增计划外依赖**；未实现 HTTP 服务器/路由；未修改 `docs/技术方案.md` 与 `readme.md`。

## 验证真实输出摘要
- `npm install` → `added 116 packages`，Exit 0（better-sqlite3 原生模块编译通过）。
- `npm run typecheck` → `tsc --noEmit`，Exit 0，无类型错误。
- `npm test` → `Test Files 2 passed (2) / Tests 25 passed (25)`，Exit 0。
- `rm -f data/smartbutler.db*` 后 `npm run db:init` → `[db:init] 建表完成，当前表： category, event_log, expiry_record, item`，Exit 0。
- `npm run db:seed` → `[db:seed] 已插入 3 个分类、5 条食材。`，Exit 0。

## Demo 运行结果（临时 tsx 脚本，已清理）
`listExpiringItems(db, 3, now)` 输出（按到期日升序）：
```
=== 三天内到期清单（按到期日升序）===
- 菠菜 x1把  剩余 1 天
- 酸奶 x4杯  剩余 2 天
```
确认：即将到期项（菠菜 1 天、酸奶 2 天）被正确筛出并升序排列；苹果（30 天）、洗衣液（无到期日）被正确排除；牛奶“下周五”视运行当日落在 3 天窗口之外。
