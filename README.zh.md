# dsh-tool-notion

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供 Notion 知识库能力的 Cordis 工具插件。Agent 可以通过自然语言搜索页面、读取文档内容、创建和更新页面、追加 Block、查询数据库并查看数据库 schema、读写评论，并查看可用用户。

插件遵循官方「一切皆插件」架构，通过 `ctx.tools.register(defineTool(...))` 注册模型可见工具，并符合 [adding-a-tool](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md) 契约。

## 安装

直接从 GitHub 安装：

```sh
npm install github:LJH-snow/dsh-tool-notion
```

或从本地目录安装：

```sh
git clone https://github.com/LJH-snow/dsh-tool-notion
cd dsh-tool-notion
npm install && npm run build
npm install /path/to/dsh-tool-notion
```

需要 `@deepseek-ai/cordis`（^4.0.1）与 `@deepseek-ai/dsh-tools`（^0.1.0-rc.6）作为 peer 依赖，由宿主 dsh 运行时提供。

## 配置

在 dsh 的组合配置（`cordis.yml`）中加载插件：

```yaml
- name: 'github:LJH-snow/dsh-tool-notion'
  config:
    apiToken: 'ntn_xxx_secret'                  # 必填：Notion Integration Token
    baseUrl: 'https://api.notion.com'          # 可选
    notionVersion: '2022-06-28'                # 可选
    timeoutMs: 15000                           # 可选，默认 15000
```

完整示例见 [examples/cordis.yml](examples/cordis.yml)。

> 安全说明：请在 Notion My integrations 创建内部集成，只授权必要的工作区和页面，不要把 token 写入版本库。所有工具都需要 token，因为 Notion 的访问权限和写权限由集成控制。

## 提供的工具

| 工具 | 说明 | 需要凭据 |
|---|---|---|
| `notion_search_pages` | 按文本搜索页面；空查询列出最近编辑页面 | 是 |
| `notion_get_page` | 读取页面标题、属性和可读 Block 内容 | 是 |
| `notion_create_page` | 在页面或数据库下创建页面 | 是 |
| `notion_update_page` | 更新标题、属性或归档状态 | 是 |
| `notion_append_blocks` | 追加 Notion Block 或纯文本段落 | 是 |
| `notion_list_databases` | 列出集成可访问的数据库 | 是 |
| `notion_get_database_schema` | 查看数据库属性名、类型、可选值和 relation/formula 细节 | 是 |
| `notion_query_database` | 使用 filter/sort JSON 查询数据库 | 是 |
| `notion_list_page_comments` | 查看页面评论 | 是 |
| `notion_add_comment` | 给页面添加评论 | 是 |
| `notion_list_users` | 列出集成可见的用户和 Bot | 是 |

Notion 结构化参数通过 JSON 字符串传入：

- `propertiesJson`：Notion 页面属性对象；数据库父页面必填。
- `childrenJson`：Notion Block 对象的 JSON 数组。
- `content`：纯文本行，自动转换为段落 Block。
- `filterJson` / `sortsJson`：数据库查询的 filter 和 sort 对象。

### 分页

`notion_search_pages`、`notion_list_databases`、`notion_query_database` 接受上一页返回的 `startCursor`，并返回 `nextCursor` 和 `hasMore`。将 `nextCursor` 作为下一页的 `startCursor` 继续分页。

### 行为约定

- 未配置凭据时返回明确业务值：读工具返回 `{ authenticated: false, ... }`，写工具返回 `{ created: false, reason }` 或 `{ ok: false, reason }`。
- 页面或数据库不存在映射为 `{ found: false }`。
- 写操作的 Notion 校验错误映射为 `{ created: false, reason }` 或 `{ ok: false, reason }`。
- 凭据无效（401）、访问禁止（403）、限流（429）、服务器错误（5xx）等基础设施错误直接抛出 `NotionError`。
- 每个请求都透传 `exec.signal`，并使用可配置超时（默认 15 秒）。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
```

架构与测试计划见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## License

[MIT](LICENSE)
