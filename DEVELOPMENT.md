# dsh-tool-notion 开发文档

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 项目名 | `dsh-tool-notion` |
| 定位 | DeepSeek Harness 的独立 Notion 知识库插件 |
| 版本 | v0.3.0 |
| 架构 | Cordis 插件 + `ctx.tools.register(defineTool(...))` |
| API | Notion REST API v1 |
| 认证 | `Authorization: Bearer <integration token>` + `Notion-Version` 头 |

### 1.1 目录

```text
src/client.ts      Notion REST 客户端：fetch 注入、超时、认证、错误映射、Block 转文本
src/index.ts       11 个 defineTool 定义与插件 apply
tests/client.spec.ts  客户端契约测试
tests/tools.spec.ts   工具注册、认证保护、JSON 参数、业务失败值、UI 呈现测试
examples/cordis.yml   dsh 组合配置示例
.github/workflows/ci.yml  Node 22/24 CI
```

## 2. 技术决策

### 2.1 范围控制

第一版定位为「Notion 知识库最小闭环」：搜索、读详情、创建、更新、追加内容、数据库查询与 schema、评论和用户元信息，共 11 个工具。后续版本再扩展分页游标、复杂 Block 编辑、关系属性转换和页面归档列表，避免插件一开始就膨胀。

Notion Search API 没有稳定的归档页面筛选字段，所以第一版用 `notion_list_page_comments` 替换了最初的 `notion_archived_pages` 建议，保留更可用的评论闭环。

v0.3 补齐分页游标：`notion_search_pages`、`notion_list_databases`、`notion_query_database` 支持 `startCursor`，响应返回 `nextCursor`/`hasMore`，工具数保持 11。

### 2.2 认证与安全

- 默认端点 `https://api.notion.com`，可通过 `baseUrl` 覆盖，自动去掉尾部斜杠。
- 所有请求携带 `Authorization: Bearer <token>`、`Notion-Version: 2022-06-28`、`Content-Type: application/json`。
- 未配置 token 时返回业务值：读工具 `{ authenticated: false, ... }`，写工具 `{ created: false, reason }` 或 `{ ok: false, reason }`。
- `401` 表示凭据无效，`403` 表示无权限，`429` 表示限流，`5xx` 表示服务端错误；这些基础设施错误抛出 `NotionError`。
- 写操作校验失败（400）映射为业务失败值。

### 2.3 Notion API 细节

- 页面搜索使用 `POST /v1/search`，固定 `filter.object == page`，按最后编辑时间倒序。
- 页面详情使用 `GET /v1/pages/{id}`，属性通过 `propertiesJson` 原样返回。
- 页面内容通过 `GET /v1/blocks/{id}/children` 获取，递归展开最多两层、最多 300 个 Block，并转换为 Markdown 风格文本。
- 数据库 schema 使用 `GET /v1/databases/{id}`，属性名、类型、select/status 可选值和 relation/formula 细节会归一化进 `propertiesJson`。
- 创建页面使用 `POST /v1/pages`；page parent 可直接传 `title`，database parent 必须传 `propertiesJson`。
- 更新页面使用 `PATCH /v1/pages/{id}`，追加 Block 使用 `PATCH /v1/blocks/{id}/children`。
- 数据库列表使用 `POST /v1/search` 的 `filter.object == database`；数据库查询使用 `POST /v1/databases/{id}/query`。
- 搜索、数据库列表和数据库查询均支持 `start_cursor` 请求参数，响应返回 `next_cursor`/`has_more`，工具层统一映射为 `startCursor`/`nextCursor`/`hasMore`。
- 评论使用 `POST /v1/comments` 与 `GET /v1/comments?block_id=...`。
- 所有 `limit` 都钳制在 1-100，默认 20。
- 每个请求使用 `AbortSignal.timeout` 与 `exec.signal` 合并，默认 15 秒超时。

### 2.4 错误映射

| 场景 | 返回/行为 |
|---|---|
| 未配置凭据（读） | `{ authenticated: false, ... }` |
| 未配置凭据（写） | `{ created: false, reason }` 或 `{ ok: false, reason }` |
| Page/Database 404 | `{ found: false }` |
| 写操作 Notion 校验失败 | `{ created: false, reason }` 或 `{ ok: false, reason }` |
| 401/403/429/5xx | 抛 `NotionError` |

## 3. 测试

```sh
npm install
npm run typecheck
npm test
npm run build
```

当前测试覆盖：

- Bearer 认证头与 `Notion-Version` 头。
- 搜索、页面详情、Block 内容读取。
- 搜索、数据库列表、数据库查询的分页游标请求与响应映射。
- 创建页面、更新页面、追加 Block 的请求体与业务失败映射。
- 数据库列表、数据库 schema、数据库查询、评论、用户结果映射。
- 11 个工具注册、无凭据保护、JSON 参数校验、render 纯函数与 present 卡片。
- 当前 21 例全绿，覆盖客户端请求/body/错误映射与工具层注册/渲染。

## 4. 后续方向

- 规则化属性映射：从 `propertiesJson` 提取常见 checker/select/date/relation 值。
- 页面归档列表：等待 Notion Search API 支持稳定归档筛选后再加入。

开发新能力时保持同一个客户端的错误映射和 Block 转文本约定，避免模型看到的返回结构分裂。
