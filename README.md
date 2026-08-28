# dsh-tool-notion

[English](README.md) | [中文](README.zh.md)

A Cordis tool plugin that gives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) Notion knowledge-base capabilities. Agents can search pages, read document content, create and update pages, append blocks, query databases and inspect their schemas, read and write comments, and list users.

It follows the official "everything is a plugin" architecture with `ctx.tools.register(defineTool(...))` and the [adding-a-tool](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md) contract.

## Install

Install directly from GitHub:

```sh
npm install github:LJH-snow/dsh-tool-notion
```

Or from a local checkout:

```sh
git clone https://github.com/LJH-snow/dsh-tool-notion
cd dsh-tool-notion
npm install && npm run build
npm install /path/to/dsh-tool-notion
```

Requires `@deepseek-ai/cordis` (^4.0.1) and `@deepseek-ai/dsh-tools` (^0.1.0-rc.6) as peer dependencies, provided by the host dsh runtime.

## Configuration

Load the plugin in a dsh composition config (`cordis.yml`):

```yaml
- name: 'github:LJH-snow/dsh-tool-notion'
  config:
    apiToken: 'ntn_xxx_secret'                  # required: Notion integration token
    baseUrl: 'https://api.notion.com'          # optional
    notionVersion: '2022-06-28'                # optional
    timeoutMs: 15000                           # optional, default 15000
```

Full example: [examples/cordis.yml](examples/cordis.yml).

> Security: create an internal integration under Notion My integrations, allow only the workspaces/pages it needs, and never commit the token. Every tool requires a token because Notion workspace access and write permissions are controlled by the integration.

## Tools

| Tool | Description | Credentials |
|---|---|---|
| `notion_search_pages` | Search pages by text; empty query lists recently edited pages | yes |
| `notion_get_page` | Read a page title, properties, and readable block content | yes |
| `notion_create_page` | Create a page under a page or database parent | yes |
| `notion_update_page` | Update title, properties, or archived state | yes |
| `notion_append_blocks` | Append Notion blocks or plain text paragraphs | yes |
| `notion_list_databases` | List databases accessible to the integration | yes |
| `notion_get_database_schema` | Get database property names, types, selectable options, and relation/formula details | yes |
| `notion_query_database` | Query a database with filter and sort JSON | yes |
| `notion_list_page_comments` | List comments on a page | yes |
| `notion_add_comment` | Add a comment to a page | yes |
| `notion_list_users` | List users and bots visible to the integration | yes |

For Notion-specific structured inputs, the plugin accepts JSON strings:

- `propertiesJson`: Notion page properties object, required for database parents.
- `childrenJson`: Notion block objects as a JSON array.
- `content`: plain text lines converted to paragraph blocks as a convenience.
- `filterJson` / `sortsJson`: Notion database query filter and sort objects.

### Behavior Contract

- Missing credentials return canonical business values: read tools return `{ authenticated: false, ... }`, write tools return `{ created: false, reason }` or `{ ok: false, reason }`.
- Missing page or database maps to `{ found: false }`.
- Notion validation errors on writes map to `{ created: false, reason }` or `{ ok: false, reason }`.
- Infrastructure errors such as invalid credentials (401), forbidden access (403), rate limiting (429), or server failures (5xx) throw `NotionError`.
- Every request forwards `exec.signal` and uses a configurable timeout (default 15 seconds).

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the architecture and test coverage.

## License

[MIT](LICENSE)
