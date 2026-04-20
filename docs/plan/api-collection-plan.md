# API Collection 详细实施计划

## 背景

AIProxy 已有 Compose 功能（手动构造并发送 HTTP 请求），但请求无法保存、分组、复用。用户在实际调试中经常需要：反复发送同一组请求、在不同环境（dev/staging/prod）间切换、从抓包流量中保存请求供后续使用。目前这些需求需要同时使用 Charles + Postman 才能满足。

API Collection 功能将 Compose 从「一次性请求编辑器」升级为「可管理的 API 调试工具」，消除用户同时开两个工具的痛点。其中「从抓包流量直接保存到 Collection」是 Postman 做不到的独特优势。

---

## 数据模型设计

### 新增 SQLite 表

#### 1. `api_collections` — 集合/文件夹

```sql
CREATE TABLE IF NOT EXISTS api_collections (
    id          TEXT NOT NULL PRIMARY KEY,
    parent_id   TEXT,                          -- NULL = 顶级集合, 有值 = 子文件夹
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_collections_parent ON api_collections(parent_id);
```

设计要点：
- 使用 `parent_id` 自引用实现树形结构（集合 → 子文件夹 → 更深文件夹）
- 集合和文件夹共用一张表，通过 `parent_id IS NULL` 区分顶级集合
- `sort_order` 支持拖拽排序

#### 2. `api_collection_items` — 集合中的请求项

```sql
CREATE TABLE IF NOT EXISTS api_collection_items (
    id            TEXT NOT NULL PRIMARY KEY,
    collection_id TEXT NOT NULL,               -- 所属集合/文件夹
    name          TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    method        TEXT NOT NULL DEFAULT 'GET',
    url           TEXT NOT NULL DEFAULT '',
    headers       TEXT NOT NULL DEFAULT '[]',  -- JSON: HeaderEntry[]
    body          TEXT NOT NULL DEFAULT '',
    body_type     TEXT NOT NULL DEFAULT 'none', -- none | formdata | urlencoded | raw
    raw_language  TEXT NOT NULL DEFAULT 'json', -- text | json | xml | html | javascript
    form_data     TEXT NOT NULL DEFAULT '[]',  -- JSON: HeaderEntry[]
    url_encoded   TEXT NOT NULL DEFAULT '[]',  -- JSON: HeaderEntry[]
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    FOREIGN KEY (collection_id) REFERENCES api_collections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_collection_items_coll ON api_collection_items(collection_id);
```

设计要点：
- 完整存储 Compose 编辑器状态（method, url, headers, body, bodyType, rawLanguage, formData, urlEncoded）
- 与 `compose-editor.store.ts` 的状态结构一一对应，方便双向转换
- JSON 字段用于存储数组类型数据（headers, form_data, url_encoded），与现有 session_details 表的模式一致

#### 3. `api_environments` — 环境定义

```sql
CREATE TABLE IF NOT EXISTS api_environments (
    id          TEXT NOT NULL PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
```

#### 4. `api_environment_variables` — 环境变量

```sql
CREATE TABLE IF NOT EXISTS api_environment_variables (
    id             TEXT NOT NULL PRIMARY KEY,
    environment_id TEXT NOT NULL,
    key            TEXT NOT NULL,
    value          TEXT NOT NULL DEFAULT '',
    enabled        INTEGER NOT NULL DEFAULT 1,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (environment_id) REFERENCES api_environments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_env_vars_env ON api_environment_variables(environment_id);
```

---

## 分阶段实施计划

### Phase 1：数据层 & 基础设施

**目标**：建立数据模型、Rust CRUD、共享类型、Tauri 命令。

#### 1.1 SQLite Schema — 修改文件

- **修改** `crates/db/src/schema.rs`
  - 在 `CREATE_TABLES` 常量末尾追加 4 张表的 DDL
  - 在 `run_migrations` 测试中更新 `expected` 数组

#### 1.2 Rust CRUD 模块 — 新增文件

- **新增** `crates/db/src/collections.rs`
  - 数据结构：
    ```rust
    struct CollectionRow { id, parent_id, name, description, sort_order, created_at, updated_at }
    struct CollectionItemRow { id, collection_id, name, description, sort_order,
                               method, url, headers, body, body_type, raw_language,
                               form_data, url_encoded, created_at, updated_at }
    ```
  - 函数：`upsert_collection`, `list_collections`, `list_collections_by_parent`, `delete_collection`, `reorder_collections`
  - 函数：`upsert_collection_item`, `list_collection_items`, `get_collection_item`, `delete_collection_item`, `reorder_collection_items`, `move_collection_item`

- **新增** `crates/db/src/environments.rs`
  - 数据结构：
    ```rust
    struct EnvironmentRow { id, name, sort_order, created_at, updated_at }
    struct EnvironmentVariableRow { id, environment_id, key, value, enabled, sort_order }
    ```
  - 函数：`upsert_environment`, `list_environments`, `delete_environment`
  - 函数：`upsert_environment_variable`, `list_environment_variables`, `delete_environment_variable`, `set_environment_variables`（批量替换）

- **修改** `crates/db/src/lib.rs`
  - 添加 `pub mod collections;` 和 `pub mod environments;`

#### 1.3 共享类型 — 修改文件

- **修改** `packages/shared-types/src/index.ts`
  - 新增类型：
    ```typescript
    type ApiCollection = {
      id: string;
      parentId: string | null;
      name: string;
      description: string;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
    };

    type ApiCollectionItem = {
      id: string;
      collectionId: string;
      name: string;
      description: string;
      sortOrder: number;
      method: string;
      url: string;
      headers: HeaderEntry[];
      body: string;
      bodyType: BodyType;        // 复用 compose-editor.store 的类型
      rawLanguage: RawLanguage;
      formData: HeaderEntry[];
      urlEncoded: HeaderEntry[];
      createdAt: string;
      updatedAt: string;
    };

    type ApiEnvironment = {
      id: string;
      name: string;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
    };

    type ApiEnvironmentVariable = {
      id: string;
      environmentId: string;
      key: string;
      value: string;
      enabled: boolean;
      sortOrder: number;
    };

    type CollectionSaveInput = {
      id?: string;
      collectionId: string;
      name: string;
      description?: string;
      method: string;
      url: string;
      headers: HeaderEntry[];
      body: string;
      bodyType: string;
      rawLanguage: string;
      formData: HeaderEntry[];
      urlEncoded: HeaderEntry[];
    };

    type SessionToCollectionInput = {
      sessionId: string;
      collectionId: string;
      name?: string;
    };

    type BatchExecuteInput = {
      itemIds: string[];
      environmentId?: string;
    };
    ```
  - 新增对应的 `isXxx()` type guard 和 `parseXxx()` parser

#### 1.4 Tauri 命令 — 修改文件

- **修改** `apps/desktop/src-tauri/src/commands/mod.rs`
  - 新增 Rust input structs（遵循现有 `SendComposedRequestInput` 模式）
  - 新增命令：

  | 命令 | 输入 | 输出 | 说明 |
  |------|------|------|------|
  | `list_api_collections` | `{ parentId?: string }` | `ApiCollection[]` | 列出集合/文件夹 |
  | `upsert_api_collection` | `ApiCollection` | `ApiCollection` | 创建/更新集合或文件夹 |
  | `delete_api_collection` | `{ id: string }` | `void` | 级联删除含所有子项 |
  | `reorder_api_collections` | `{ ids: string[] }` | `void` | 批量更新排序 |
  | `list_api_collection_items` | `{ collectionId: string }` | `ApiCollectionItem[]` | 列出集合内请求 |
  | `get_api_collection_item` | `{ id: string }` | `ApiCollectionItem` | 获取单个请求详情 |
  | `upsert_api_collection_item` | `CollectionSaveInput` | `ApiCollectionItem` | 创建/更新请求 |
  | `delete_api_collection_item` | `{ id: string }` | `void` | 删除请求 |
  | `move_api_collection_item` | `{ id: string, targetCollectionId: string }` | `void` | 移动到其他集合 |
  | `save_session_to_collection` | `SessionToCollectionInput` | `ApiCollectionItem` | 从抓包流量保存 |
  | `list_api_environments` | — | `ApiEnvironment[]` | 列出环境 |
  | `upsert_api_environment` | `ApiEnvironment` | `ApiEnvironment` | 创建/更新环境 |
  | `delete_api_environment` | `{ id: string }` | `void` | 删除环境 |
  | `list_api_environment_variables` | `{ environmentId: string }` | `ApiEnvironmentVariable[]` | 列出变量 |
  | `set_api_environment_variables` | `{ environmentId: string, variables: ApiEnvironmentVariable[] }` | `void` | 批量设置变量 |
  | `batch_execute_collection_items` | `BatchExecuteInput` | `SessionDetail[]` | 批量执行 |

#### 1.5 前端 Service 层 — 修改文件

- **修改** `apps/desktop/src/services/commands/index.ts`
  - 为每个 Tauri 命令添加对应的 TypeScript wrapper 函数
  - 遵循现有模式：`invoke()` → `parseXxx()` → fallback mock

**预估工作量**：中

---

### Phase 2：Collection 管理 UI

**目标**：实现 Collection 页面，支持集合/文件夹的 CRUD、请求的编辑与发送。

#### 2.1 路由 & 导航 — 修改文件

- **修改** `apps/desktop/src/features/navigation/navigation-items.tsx`
  - 在 compose 之后添加 Collection 导航项
  - 使用 `FolderCopyRoundedIcon` 图标
  - `group: "workspace"`, `to: "/collections"`

- **修改** `apps/desktop/src/app/router/index.tsx`
  - 添加 `/collections` 路由指向 `CollectionsPage`

#### 2.2 页面结构 — 新增文件

- **新增** `apps/desktop/src/pages/collections/index.tsx` — `CollectionsPage`

页面布局（三栏结构）：

```
┌──────────────────────────────────────────────────┐
│  CollectionsPage                                  │
│ ┌────────────┐ ┌──────────────┐ ┌──────────────┐ │
│ │ Collection │ │  Item List   │ │  Item Editor │ │
│ │   Tree     │ │   Pane       │ │   Pane       │ │
│ │            │ │              │ │              │ │
│ │ ▸ Auth     │ │ GET Login    │ │ [URL Bar]    │ │
│ │ ▾ User     │ │ POST Create  │ │ [Request]    │ │
│ │   ▸ Profile│ │ GET  Profile │ │ [Response]   │ │
│ │   ▸ Orders │ │              │ │              │ │
│ │            │ │              │ │              │ │
│ │ [+ New]    │ │ [+ Save]     │ │ [Send]       │ │
│ └────────────┘ └──────────────┘ └──────────────┘ │
└──────────────────────────────────────────────────┘
```

组件树：
```
CollectionsPage
  ├── CollectionTreePane (左栏)
  │   ├── CollectionTree           -- 树形结构，支持展开/折叠
  │   │   ├── CollectionTreeNode   -- 单个集合/文件夹节点
  │   │   └── CollectionTreeNode   -- 子节点（递归）
  │   └── CreateCollectionDialog   -- 新建集合/文件夹弹窗
  ├── CollectionItemListPane (中栏)
  │   ├── ItemListHeader           -- 搜索、排序
  │   ├── ItemListRows             -- 请求列表（method badge + name + url）
  │   └── SaveToCollectionDialog   -- 从 Compose 保存的弹窗
  └── CollectionItemEditorPane (右栏)
      ├── EditorToolbar            -- 名称、描述、保存按钮
      ├── URLBar                   -- 复用 Compose 的 URL 栏模式
      ├── ComposeRequestSection    -- 直接复用现有组件
      └── ComposeResponseSection   -- 直接复用现有组件
```

#### 2.3 前端 Feature 模块 — 新增文件

- **新增** `apps/desktop/src/features/collections/`
  - `use-collections.ts` — React Query hooks：`useCollections()`, `useUpsertCollection()`, `useDeleteCollection()`, `useReorderCollections()`
  - `use-collection-items.ts` — React Query hooks：`useCollectionItems()`, `useCollectionItem()`, `useUpsertCollectionItem()`, `useDeleteCollectionItem()`, `useMoveCollectionItem()`
  - `collection-editor.store.ts` — Zustand store，管理当前编辑项状态
  - `collection-tree.helpers.ts` — 树形结构构建、查找、展开/折叠等纯函数
  - `components/CollectionTreePane.tsx`
  - `components/CollectionTreeNode.tsx`
  - `components/CollectionItemListPane.tsx`
  - `components/CollectionItemEditorPane.tsx`
  - `components/CreateCollectionDialog.tsx`

#### 2.4 核心交互流程

1. **创建集合**：点击左栏 [+ New] → 输入名称 → 创建顶级集合或子文件夹
2. **保存请求到集合**：
   - 在 Collection 页面：点击中栏 [+ Save] → 填写名称 → 基于当前编辑器状态保存
   - 在 Compose 页面：添加「保存到集合」按钮 → 弹窗选择目标集合 → 保存
3. **打开并编辑请求**：在树/列表中点击请求 → 加载到编辑器 → 修改 → 发送
4. **拖拽排序**：树节点和列表项均支持拖拽调整顺序

#### 2.5 i18n — 修改文件

- **修改** `apps/desktop/src/i18n/messages/en.ts`
- **修改** `apps/desktop/src/i18n/messages/zh-CN.ts`
  - 新增 `collectionsPage.*` 和 `navigation.collections` 相关 key

**预估工作量**：大

---

### Phase 3：环境变量

**目标**：支持多环境管理，URL/Headers/Body 中的 `{{variable}}` 自动替换。

#### 3.1 变量替换引擎 — 新增文件

- **新增** `apps/desktop/src/features/collections/variable-substitution.ts`
  - 纯函数，无副作用：
    ```typescript
    function substituteVariables(template: string, variables: Map<string, string>): string
    function substituteHeaders(headers: HeaderEntry[], variables: Map<string, string>): HeaderEntry[]
    function substituteRequest(item: ApiCollectionItem, variables: Map<string, string>): ComposedRequestInput
    ```
  - 替换规则：匹配 `{{key}}`，替换为对应 value；未匹配的变量保持原样（不报错，但可高亮提示）
  - 需考虑 edge case：`{{}}` 忽略、嵌套 `{{{key}}}` 只替换内层

#### 3.2 环境管理 UI — 新增文件

- **新增** `apps/desktop/src/features/environments/`
  - `use-environments.ts` — React Query hooks
  - `components/EnvironmentManager.tsx` — 环境列表 + 变量编辑表
  - `components/EnvironmentSelector.tsx` — 下拉选择器，放置在 CollectionsPage 顶部 toolbar

- **新增** `features/collections/environment-editor.store.ts` — Zustand store
  - 管理当前选中环境 ID
  - 持久化到 localStorage：`aiproxy.collections.activeEnvironmentId`

#### 3.3 环境集成到请求发送

- 修改 `CollectionItemEditorPane` 的发送逻辑：
  1. 获取当前选中环境的变量列表
  2. 调用 `substituteRequest()` 替换 URL/Headers/Body
  3. 用替换后的 `ComposedRequestInput` 调用 `sendComposedRequest`

- URL 栏增强：检测到 `{{...}}` 时高亮显示未定义变量（黄色波浪下划线）

**预估工作量**：中

---

### Phase 4：从抓包流量保存到 Collection

**目标**：在 Sessions 页面右键菜单添加「保存到 Collection」，一键将抓到的请求保存为 Collection Item。

#### 4.1 Session 右键菜单增强 — 修改文件

- **修改** `apps/desktop/src/features/sessions/use-session-context-actions.ts`
  - 新增 `handleSaveToCollection(session: SessionSummary, collectionId: string, name?: string)` 回调
  - 内部逻辑：
    1. 调用 `getSessionDetail(session.id)` 获取完整请求详情
    2. 映射为 `CollectionSaveInput`（从 `SessionDetail` 提取 method, url, headers, body）
    3. 调用 `saveSessionToCollection` Tauri 命令
  - 映射规则：
    ```typescript
    method → session.method
    url    → session.url
    headers → detail.requestHeaders
    body   → detail.requestBody?.inlineText ?? ""
    bodyType → 根据 Content-Type 推断（application/json → raw/json, multipart → formdata, urlencoded → urlencoded, 其他 → raw/text）
    formData / urlEncoded → 根据 bodyType 从 body 解析
    ```

- **修改** `apps/desktop/src/features/sessions/components/SessionContextMenu.tsx`（或等效的右键菜单组件）
  - 在现有菜单项（Copy URL, Compose, Repeat 等）之后添加「Save to Collection」选项
  - 点击后弹出 `SaveToCollectionDialog`（选择目标集合 + 可编辑名称）

#### 4.2 保存弹窗 — 新增/复用文件

- **复用** `features/collections/components/SaveToCollectionDialog.tsx`
  - 展示集合树供用户选择目标
  - 预填请求名称（`${method} ${host}${path}`）
  - 确认后调用 `handleSaveToCollection`

#### 4.3 Rust 端：save_session_to_collection 命令

- 在 Tauri 命令层实现 `save_session_to_collection`
  - 输入：`{ sessionId, collectionId, name? }`
  - 逻辑：
    1. 从 SQLite 加载 `session_summary` + `session_detail`
    2. 映射为 `ApiCollectionItem` 字段
    3. 调用 `db::collections::upsert_collection_item`
    4. 返回新建的 item

**预估工作量**：中

---

### Phase 5：批量执行

**目标**：选中多个 Collection Item 按顺序执行，结果汇总展示。

#### 5.1 批量执行引擎 — Rust 端

- **修改** `apps/desktop/src-tauri/src/commands/mod.rs`
  - 新增 `batch_execute_collection_items` 命令
  - 输入：`{ itemIds: string[], environmentId?: string }`
  - 逻辑：
    1. 从 DB 加载每个 item
    2. 如指定 environmentId，加载变量并替换
    3. 按顺序对每个 item 调用 `send_direct_request`
    4. 收集所有结果，返回 `Vec<ProxySessionDetail>`
  - 进度反馈：每完成一个请求，发射 Tauri 事件 `batch-execute-progress`

#### 5.2 批量执行 UI — 新增文件

- **新增** `apps/desktop/src/features/collections/components/BatchExecuteDialog.tsx`
  - 展示选中项列表，支持调整执行顺序
  - 环境选择器
  - 执行按钮 + 进度条
  - 结果列表：每个请求的状态码、耗时、通过/失败状态
  - 点击结果项可查看完整响应

#### 5.3 触发方式

- 在 `CollectionItemListPane` 添加多选支持（复选框）
- 选中多项后，toolbar 出现「Batch Execute」按钮

**预估工作量**：中

---

## 文件清单汇总

### 新增文件

| 文件路径 | 说明 |
|----------|------|
| `crates/db/src/collections.rs` | Collection/Item Rust CRUD |
| `crates/db/src/environments.rs` | Environment/Variable Rust CRUD |
| `apps/desktop/src/pages/collections/index.tsx` | CollectionsPage 页面 |
| `apps/desktop/src/features/collections/use-collections.ts` | 集合 React Query hooks |
| `apps/desktop/src/features/collections/use-collection-items.ts` | 请求项 React Query hooks |
| `apps/desktop/src/features/collections/collection-editor.store.ts` | 编辑器 Zustand store |
| `apps/desktop/src/features/collections/collection-tree.helpers.ts` | 树结构纯函数 |
| `apps/desktop/src/features/collections/variable-substitution.ts` | 变量替换引擎 |
| `apps/desktop/src/features/collections/environment-editor.store.ts` | 环境 Zustand store |
| `apps/desktop/src/features/collections/components/CollectionTreePane.tsx` | 左栏：集合树 |
| `apps/desktop/src/features/collections/components/CollectionTreeNode.tsx` | 树节点组件 |
| `apps/desktop/src/features/collections/components/CollectionItemListPane.tsx` | 中栏：请求列表 |
| `apps/desktop/src/features/collections/components/CollectionItemEditorPane.tsx` | 右栏：请求编辑器 |
| `apps/desktop/src/features/collections/components/CreateCollectionDialog.tsx` | 新建集合弹窗 |
| `apps/desktop/src/features/collections/components/SaveToCollectionDialog.tsx` | 保存到集合弹窗 |
| `apps/desktop/src/features/collections/components/BatchExecuteDialog.tsx` | 批量执行弹窗 |
| `apps/desktop/src/features/environments/use-environments.ts` | 环境 React Query hooks |
| `apps/desktop/src/features/environments/components/EnvironmentManager.tsx` | 环境管理 UI |
| `apps/desktop/src/features/environments/components/EnvironmentSelector.tsx` | 环境选择下拉 |

### 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `crates/db/src/schema.rs` | 新增 4 张表的 DDL |
| `crates/db/src/lib.rs` | 注册新模块 |
| `packages/shared-types/src/index.ts` | 新增 Collection/Environment 类型 |
| `apps/desktop/src-tauri/src/commands/mod.rs` | 新增 ~16 个 Tauri 命令 |
| `apps/desktop/src/services/commands/index.ts` | 新增命令 wrapper 函数 |
| `apps/desktop/src/features/navigation/navigation-items.tsx` | 添加 Collection 导航项 |
| `apps/desktop/src/app/router/index.tsx` | 添加 `/collections` 路由 |
| `apps/desktop/src/features/sessions/use-session-context-actions.ts` | 添加 saveToCollection 回调 |
| `apps/desktop/src/i18n/messages/en.ts` | 新增 Collection 相关文案 |
| `apps/desktop/src/i18n/messages/zh-CN.ts` | 新增 Collection 相关文案 |

### 文档更新（每个 Phase 完成后同步）

| 文档 | 更新内容 |
|------|----------|
| `docs/API_SPEC.md` | 新增 Collection 相关命令文档 |
| `docs/ARCHITECTURE.md` | 新增 Collection 模块说明 |
| `docs/PAGE_BLUEPRINTS.md` | 新增 CollectionsPage 页面蓝图 |
| `docs/UI_GUIDELINES.md` | 新增 Collection 交互规范 |

---

## 复用策略

| 现有组件/模块 | 复用方式 |
|---------------|----------|
| `ComposeRequestSection` | CollectionItemEditorPane 直接嵌入，用于编辑请求 headers/body/query |
| `ComposeResponseSection` | CollectionItemEditorPane 直接嵌入，展示发送结果 |
| `EditableKeyValueTable` | 环境变量编辑表复用 |
| `useSendComposedRequest` | 发送单个请求时复用 mutation hook |
| `send_direct_request` (Rust) | 批量执行和单个发送的底层调用 |
| `loadFromSession` (Zustand) | 模式参考：Collection 编辑器也用类似 `loadFromItem` 方法 |

---

## 验证计划

### Phase 1 验证
- 运行 `cargo test` 验证 SQLite 新表创建和 CRUD
- 在 Tauri dev console 调用新增命令验证数据存取

### Phase 2 验证
- `pnpm --filter @aiproxy/desktop dev` 启动开发模式
- 创建/删除/重命名集合和文件夹
- 在集合中保存、编辑、发送请求
- 验证请求编辑器与 Compose 页面行为一致
- 运行 `pnpm --filter @aiproxy/desktop lint && pnpm --filter @aiproxy/desktop typecheck`

### Phase 3 验证
- 创建多个环境，每个环境设置不同的 baseUrl 和 token
- 切换环境后发送请求，验证变量替换正确
- 测试 `{{undefinedVar}}` 不会被替换且不崩溃

### Phase 4 验证
- 在 Sessions 页面右键点击任意请求 → Save to Collection
- 验证保存的请求包含完整的 method/url/headers/body
- 打开保存的请求验证可正常编辑和发送

### Phase 5 验证
- 选中多个 Collection Item → Batch Execute
- 验证按顺序执行，结果正确显示
- 验证环境变量在批量执行中正确替换

---

## 风险与注意事项

1. **树形结构性能**：集合树采用 `parent_id` 自引用，深层嵌套时需要递归查询。初期数据量小可接受，后续可引入 `path` 物化路径字段优化。
2. **变量替换安全**：`{{variable}}` 替换需防止正则注入，使用简单字符串匹配而非正则。
3. **批量执行中断**：批量执行中某个请求失败时，提供「继续/停止」选项。
4. **向后兼容**：新增的 SQLite 表通过 `CREATE TABLE IF NOT EXISTS` 创建，不影响现有数据。
5. **跨平台**：所有新增功能基于 Tauri + SQLite + React，天然跨平台，无需额外处理。
