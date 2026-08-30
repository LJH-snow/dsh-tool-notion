import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { NotionClient, NotionError } from './client.js'

export const name = 'dsh-tool-notion'
export const inject = ['tools']

export interface NotionPluginConfig {
  /** Notion internal integration token. */
  apiToken?: string
  /** REST API endpoint override, default https://api.notion.com. */
  baseUrl?: string
  /** Notion API version header, default 2022-06-28. */
  notionVersion?: string
  /** Request timeout in milliseconds. */
  timeoutMs?: number
}

export function apply(ctx: Context, config: NotionPluginConfig = {}) {
  const client = new NotionClient({
    apiToken: config.apiToken,
    baseUrl: config.baseUrl,
    notionVersion: config.notionVersion,
    timeoutMs: config.timeoutMs,
  })
  for (const tool of createTools(client)) {
    ctx.tools.register(tool)
  }
}

/** Build the tool definitions for a client. Exported so tests can drive execute/render directly. */
export function createTools(client: NotionClient) {
  return [
    defineTool({
      name: 'notion_search_pages',
      description: 'Search Notion pages by text. Empty query lists recently edited pages accessible to the integration.',
      parameters: {
        query: { type: 'string', description: 'Search text; leave empty to list recent pages' },
        limit: { type: 'integer', description: 'Maximum pages, 1-100 (default 20)' },
        startCursor: { type: 'string', description: 'Opaque cursor from a previous response nextCursor' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            authenticated: { type: 'boolean' },
            found: { type: 'boolean' },
            reason: { type: 'string' },
            nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Opaque cursor for the next page' },
            hasMore: { type: 'boolean', description: 'Whether another page is available' },
            items: { type: 'array', items: pageItemSchema },
          },
        },
        render: (_args, value) => {
          if (!value.authenticated) return [{ type: 'text', text: 'Searching Notion pages requires an integration token.' }]
          if (!value.found) return [{ type: 'text', text: value.reason ?? 'Notion pages are not accessible.' }]
          return renderPageList(value.items ?? [])
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Search Notion: ${args.query ?? 'all pages'}`, kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { authenticated?: boolean; found?: boolean; items?: unknown[]; reason?: string; hasMore?: boolean }
        if (!v.authenticated) return { card: 'generic', title: 'Requires Notion token' }
        if (!v.found) return { card: 'generic', title: 'Pages unavailable' }
        return { card: 'generic', title: `${(v.items ?? []).length} page(s)${v.hasMore ? ' (more)' : ''}` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { authenticated: false, found: false, items: [], reason: 'Searching Notion pages requires a Notion integration token.' }
        const result = await client.searchPages(args.query ?? '', {
          limit: clampLimit(args.limit),
          startCursor: args.startCursor,
          signal: exec.signal,
        })
        return { authenticated: true, found: true, items: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore }
      },
    }),

    defineTool({
      name: 'notion_get_page',
      description: 'Get a Notion page by UUID, including title, properties, and readable block content.',
      parameters: {
        id: { type: 'string', required: true, description: 'Notion page UUID' },
        includeContent: { type: 'boolean', description: 'Fetch page block content (default true)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            authenticated: { type: 'boolean' },
            found: { type: 'boolean' },
            reason: { type: 'string' },
            id: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
            archived: { type: 'boolean' },
            createdTime: { type: 'string' },
            lastEditedTime: { type: 'string' },
            parentType: { type: 'string' },
            parentId: { type: 'string' },
            propertiesJson: { type: 'string' },
            content: { type: 'string' },
            blockCount: { type: 'number' },
          },
        },
        render: (_args, value) => {
          if (!value.authenticated) return [{ type: 'text', text: 'Reading a Notion page requires an integration token.' }]
          if (!value.found) return [{ type: 'text', text: 'Notion page not found.' }]
          const lines = [
            `${value.title ?? '(untitled)'}`,
            `url: ${value.url ?? ''}`,
            value.parentType ? `parent: ${value.parentType} ${value.parentId ?? ''}` : '',
            value.lastEditedTime ? `edited: ${value.lastEditedTime}` : '',
            value.content || value.content === '' ? `content:\n${value.content}` : '',
          ].filter(Boolean)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Notion page ${args.id}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { authenticated?: boolean; found?: boolean; title?: string; blockCount?: number }
        if (!v.authenticated) return { card: 'generic', title: 'Requires Notion token' }
        if (!v.found) return { card: 'generic', title: 'Page not found' }
        return { card: 'generic', title: v.title ?? '(untitled)', content: [{ type: 'text', text: `${v.blockCount ?? 0} block(s)` }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { authenticated: false, found: false, reason: 'Reading a Notion page requires a Notion integration token.' }
        try {
          const info = await client.getPage(args.id as string, { includeContent: args.includeContent, signal: exec.signal })
          return { authenticated: true, found: true, ...info }
        } catch (error) {
          if (error instanceof NotionError && (error.status === 404 || /not found/i.test(error.message))) {
            return { authenticated: true, found: false }
          }
          throw error
        }
      },
    }),

    defineTool({
      name: 'notion_create_page',
      description: 'Create a Notion page under a page or database parent. WRITE operation: requires an integration token.',
      parameters: {
        parentPageId: { type: 'string', description: 'Parent page UUID; page title becomes the page name' },
        parentDatabaseId: { type: 'string', description: 'Parent database UUID; requires propertiesJson matching the database schema' },
        title: { type: 'string', description: 'Page title for page parents, or optional convenience title property' },
        propertiesJson: { type: 'string', description: 'Notion properties object as JSON; required for database parents' },
        childrenJson: { type: 'string', description: 'Notion block objects as JSON array; optional' },
        content: { type: 'string', description: 'Plain text lines to send as paragraph blocks; optional' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            created: { type: 'boolean' },
            id: { type: 'string' },
            url: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.created) return [{ type: 'text', text: `Created Notion page ${value.id}.` }]
          return [{ type: 'text', text: `Could not create the Notion page: ${value.reason}` }]
        },
      },
      presentCall(args): ToolCallView {
        const parent = args.parentPageId ? 'page' : 'database'
        return { card: 'generic', title: `Create Notion page in ${parent}`, kind: 'edit' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { created?: boolean; id?: string; reason?: string }
        if (v.created) return { card: 'generic', title: `Notion page ${v.id} created` }
        return { card: 'generic', title: 'Create page failed', content: [{ type: 'text', text: v.reason ?? 'Unknown' }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { created: false, reason: 'Creating a Notion page requires a Notion integration token.' }
        if (!args.parentPageId && !args.parentDatabaseId) {
          return { created: false, reason: 'Provide parentPageId or parentDatabaseId.' }
        }
        if (args.parentPageId && args.parentDatabaseId) {
          return { created: false, reason: 'Provide exactly one of parentPageId or parentDatabaseId.' }
        }
        const properties = parseJsonObject(args.propertiesJson)
        if (args.propertiesJson && !properties.ok) {
          return { created: false, reason: 'propertiesJson must be a valid JSON object.' }
        }
        if (args.parentDatabaseId && !properties.value) {
          return { created: false, reason: 'A database page requires propertiesJson.' }
        }
        const children = buildChildren(args.childrenJson, args.content)
        if (!children.ok) return { created: false, reason: children.reason }
        return client.createPage({
          parentPageId: args.parentPageId,
          parentDatabaseId: args.parentDatabaseId,
          title: args.title,
          properties: properties.value,
          children: children.value,
          signal: exec.signal,
        })
      },
    }),

    defineTool({
      name: 'notion_update_page',
      description: 'Update a Notion page title, properties, or archived state. WRITE operation: requires an integration token.',
      parameters: {
        id: { type: 'string', required: true, description: 'Notion page UUID' },
        title: { type: 'string', description: 'New page title for page-parented pages' },
        propertiesJson: { type: 'string', description: 'Notion properties object as JSON' },
        archived: { type: 'boolean', description: 'Archive or unarchive the page' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok) return [{ type: 'text', text: `Updated Notion page ${value.id ?? _args.id}.` }]
          return [{ type: 'text', text: `Could not update the Notion page: ${value.reason}` }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Update Notion page ${args.id}`, kind: 'edit' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { ok?: boolean; id?: string; reason?: string }
        if (v.ok) return { card: 'generic', title: `Page ${v.id ?? _args.id} updated` }
        return { card: 'generic', title: 'Update page failed', content: [{ type: 'text', text: v.reason ?? 'Unknown' }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { ok: false, id: args.id as string, reason: 'Updating a Notion page requires a Notion integration token.' }
        const hasProperties = args.propertiesJson !== undefined && args.propertiesJson.trim() !== ''
        if (args.title === undefined && !hasProperties && args.archived === undefined) {
          return { ok: false, id: args.id as string, reason: 'Provide at least title, propertiesJson, or archived.' }
        }
        const properties = parseJsonObject(args.propertiesJson)
        if (args.propertiesJson && !properties.ok) {
          return { ok: false, id: args.id as string, reason: 'propertiesJson must be a valid JSON object.' }
        }
        return client.updatePage(args.id as string, {
          title: args.title,
          archived: args.archived,
          properties: properties.value,
          signal: exec.signal,
        })
      },
    }),

    defineTool({
      name: 'notion_append_blocks',
      description: 'Append Notion blocks to a page or block. WRITE operation: requires an integration token.',
      parameters: {
        blockId: { type: 'string', required: true, description: 'Page or block UUID to append under' },
        childrenJson: { type: 'string', description: 'Notion block objects as JSON array' },
        content: { type: 'string', description: 'Plain text lines to send as paragraph blocks' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok) return [{ type: 'text', text: `Appended blocks to ${_args.blockId}.` }]
          return [{ type: 'text', text: `Could not append blocks: ${value.reason}` }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Append to ${args.blockId}`, kind: 'edit' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { ok?: boolean; id?: string; reason?: string }
        if (v.ok) return { card: 'generic', title: `Blocks appended to ${_args.blockId}` }
        return { card: 'generic', title: 'Append failed', content: [{ type: 'text', text: v.reason ?? 'Unknown' }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { ok: false, reason: 'Appending Notion blocks requires a Notion integration token.' }
        const children = buildChildren(args.childrenJson, args.content)
        if (!children.ok) return { ok: false, reason: children.reason }
        if (!children.value?.length) return { ok: false, reason: 'Provide childrenJson or content.' }
        return client.appendBlocks(args.blockId as string, { children: children.value, signal: exec.signal })
      },
    }),

    defineTool({
      name: 'notion_list_databases',
      description: 'List Notion databases accessible to the integration.',
      parameters: {
        limit: { type: 'integer', description: 'Maximum databases, 1-100 (default 20)' },
        startCursor: { type: 'string', description: 'Opaque cursor from a previous response nextCursor' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            authenticated: { type: 'boolean' },
            found: { type: 'boolean' },
            reason: { type: 'string' },
            nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Opaque cursor for the next page' },
            hasMore: { type: 'boolean', description: 'Whether another page is available' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  url: { type: 'string' },
                  archived: { type: 'boolean' },
                  createdTime: { type: 'string' },
                  lastEditedTime: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.authenticated) return [{ type: 'text', text: 'Listing Notion databases requires an integration token.' }]
          if (!value.found) return [{ type: 'text', text: value.reason ?? 'Notion databases are not accessible.' }]
          return renderDatabaseList(value.items ?? [])
        },
      },
      presentCall(): ToolCallView {
        return { card: 'generic', title: 'Notion databases', kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { authenticated?: boolean; found?: boolean; items?: unknown[]; hasMore?: boolean }
        if (!v.authenticated) return { card: 'generic', title: 'Requires Notion token' }
        if (!v.found) return { card: 'generic', title: 'Databases unavailable' }
        return { card: 'generic', title: `${(v.items ?? []).length} database(s)${v.hasMore ? ' (more)' : ''}` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { authenticated: false, found: false, items: [], reason: 'Listing Notion databases requires a Notion integration token.' }
        const result = await client.listDatabases({
          limit: clampLimit(args.limit),
          startCursor: args.startCursor,
          signal: exec.signal,
        })
        return { authenticated: true, found: true, items: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore }
      },
    }),

    defineTool({
      name: 'notion_get_database_schema',
      description: 'Get a Notion database schema: property names, types, selectable options, and relation/formula details.',
      parameters: {
        databaseId: { type: 'string', required: true, description: 'Notion database UUID' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            authenticated: { type: 'boolean' },
            found: { type: 'boolean' },
            reason: { type: 'string' },
            id: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
            lastEditedTime: { type: 'string' },
            propertyCount: { type: 'number' },
            propertiesJson: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (!value.authenticated) return [{ type: 'text', text: 'Getting a Notion database schema requires an integration token.' }]
          if (!value.found) return [{ type: 'text', text: value.reason ?? 'Notion database not found.' }]
          return renderDatabaseSchema(value)
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Notion database schema ${args.databaseId}`, kind: 'read' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { authenticated?: boolean; found?: boolean; propertyCount?: number }
        if (!v.authenticated) return { card: 'generic', title: 'Requires Notion token' }
        if (!v.found) return { card: 'generic', title: 'Database not found' }
        return { card: 'generic', title: `${v.propertyCount ?? 0} database properties`, content: [{ type: 'text', text: `${v.propertyCount ?? 0} database properties` }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) {
          return { authenticated: false, found: false, reason: 'Getting a Notion database schema requires a Notion integration token.' }
        }
        try {
          const schema = await client.getDatabase(args.databaseId as string, { signal: exec.signal })
          return { authenticated: true, found: true, ...schema }
        } catch (error) {
          if (error instanceof NotionError && (error.status === 404 || /not found/i.test(error.message))) {
            return { authenticated: true, found: false, reason: 'Notion database not found.' }
          }
          throw error
        }
      },
    }),

    defineTool({
      name: 'notion_query_database',
      description: 'Query a Notion database and return matching pages with their titles and properties.',
      parameters: {
        databaseId: { type: 'string', required: true, description: 'Notion database UUID' },
        filterJson: { type: 'string', description: 'Notion database query filter as JSON object; optional' },
        sortsJson: { type: 'string', description: 'Notion database query sorts as JSON array; optional' },
        limit: { type: 'integer', description: 'Maximum pages, 1-100 (default 20)' },
        startCursor: { type: 'string', description: 'Opaque cursor from a previous response nextCursor' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            authenticated: { type: 'boolean' },
            found: { type: 'boolean' },
            reason: { type: 'string' },
            nextCursor: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Opaque cursor for the next page' },
            hasMore: { type: 'boolean', description: 'Whether another page is available' },
            items: { type: 'array', items: pageItemSchema },
          },
        },
        render: (_args, value) => {
          if (!value.authenticated) return [{ type: 'text', text: 'Querying a Notion database requires an integration token.' }]
          if (!value.found) return [{ type: 'text', text: value.reason ?? 'Database not found.' }]
          return renderPageList(value.items ?? [])
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Query Notion database ${args.databaseId}`, kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { authenticated?: boolean; found?: boolean; items?: unknown[]; hasMore?: boolean }
        if (!v.authenticated) return { card: 'generic', title: 'Requires Notion token' }
        if (!v.found) return { card: 'generic', title: 'Database unavailable' }
        return { card: 'generic', title: `${(v.items ?? []).length} page(s)${v.hasMore ? ' (more)' : ''}` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { authenticated: false, found: false, items: [], reason: 'Querying a Notion database requires a Notion integration token.' }
        const filter = parseJsonObject(args.filterJson)
        if (args.filterJson && !filter.ok) return { authenticated: true, found: false, items: [], reason: 'filterJson must be a valid JSON object.' }
        const sorts = parseJsonArray(args.sortsJson)
        if (args.sortsJson && !sorts.ok) return { authenticated: true, found: false, items: [], reason: 'sortsJson must be a valid JSON array.' }
        try {
          const result = await client.queryDatabase(args.databaseId as string, {
            filter: filter.value,
            sorts: sorts.value,
            limit: clampLimit(args.limit),
            startCursor: args.startCursor,
            signal: exec.signal,
          })
          return { authenticated: true, found: true, items: result.items, nextCursor: result.nextCursor, hasMore: result.hasMore }
        } catch (error) {
          if (error instanceof NotionError && (error.status === 404 || /not found/i.test(error.message))) {
            return { authenticated: true, found: false, items: [], reason: 'Notion database not found.' }
          }
          throw error
        }
      },
    }),

    defineTool({
      name: 'notion_list_page_comments',
      description: 'List comments on a Notion page.',
      parameters: {
        pageId: { type: 'string', required: true, description: 'Notion page UUID' },
        limit: { type: 'integer', description: 'Maximum comments, 1-100 (default 20)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            authenticated: { type: 'boolean' },
            found: { type: 'boolean' },
            reason: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  authorName: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  createdTime: { type: 'string' },
                  parentType: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  parentId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.authenticated) return [{ type: 'text', text: 'Listing Notion comments requires an integration token.' }]
          if (!value.found) return [{ type: 'text', text: value.reason ?? 'Page not found.' }]
          return renderCommentList(value.items ?? [])
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Comments on ${args.pageId}`, kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { authenticated?: boolean; found?: boolean; items?: unknown[] }
        if (!v.authenticated) return { card: 'generic', title: 'Requires Notion token' }
        if (!v.found) return { card: 'generic', title: 'Page not found' }
        return { card: 'generic', title: `${(v.items ?? []).length} comment(s)` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { authenticated: false, found: false, items: [], reason: 'Listing Notion comments requires a Notion integration token.' }
        try {
          const items = await client.listPageComments(args.pageId as string, { limit: clampLimit(args.limit), signal: exec.signal })
          return { authenticated: true, found: true, items }
        } catch (error) {
          if (error instanceof NotionError && (error.status === 404 || /not found/i.test(error.message))) {
            return { authenticated: true, found: false, items: [], reason: 'Notion page not found.' }
          }
          throw error
        }
      },
    }),

    defineTool({
      name: 'notion_add_comment',
      description: 'Add a comment to a Notion page. WRITE operation: requires an integration token.',
      parameters: {
        pageId: { type: 'string', required: true, description: 'Notion page UUID' },
        text: { type: 'string', required: true, description: 'Comment text' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (_args, value) => {
          if (value.ok) return [{ type: 'text', text: `Comment ${value.id} added to ${_args.pageId}.` }]
          return [{ type: 'text', text: `Could not add the comment: ${value.reason}` }]
        },
      },
      presentCall(args): ToolCallView {
        return { card: 'generic', title: `Comment on ${args.pageId}`, kind: 'edit' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { ok?: boolean; id?: string; reason?: string }
        if (v.ok) return { card: 'generic', title: `Comment ${v.id} added` }
        return { card: 'generic', title: 'Add comment failed', content: [{ type: 'text', text: v.reason ?? 'Unknown' }] }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { ok: false, reason: 'Adding a Notion comment requires a Notion integration token.' }
        if (!args.text?.trim()) return { ok: false, reason: 'Provide comment text.' }
        return client.addComment(args.pageId as string, args.text, exec.signal)
      },
    }),

    defineTool({
      name: 'notion_list_users',
      description: 'List Notion users and bots visible to the integration.',
      parameters: {
        limit: { type: 'integer', description: 'Maximum users, 1-100 (default 20)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            authenticated: { type: 'boolean' },
            found: { type: 'boolean' },
            reason: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string' },
                  name: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  avatarUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  email: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  botWorkspaceName: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (!value.authenticated) return [{ type: 'text', text: 'Listing Notion users requires an integration token.' }]
          if (!value.found) return [{ type: 'text', text: value.reason ?? 'Notion users are not accessible.' }]
          return renderUserList(value.items ?? [])
        },
      },
      presentCall(): ToolCallView {
        return { card: 'generic', title: 'Notion users', kind: 'search' }
      },
      presentResult(_args, result): ToolResultView | undefined {
        const v = result as unknown as { authenticated?: boolean; found?: boolean; items?: unknown[] }
        if (!v.authenticated) return { card: 'generic', title: 'Requires Notion token' }
        if (!v.found) return { card: 'generic', title: 'Users unavailable' }
        return { card: 'generic', title: `${(v.items ?? []).length} user(s)` }
      },
      async execute(args, exec) {
        if (!client.hasToken()) return { authenticated: false, found: false, items: [], reason: 'Listing Notion users requires a Notion integration token.' }
        const items = await client.listUsers({ limit: clampLimit(args.limit), signal: exec.signal })
        return { authenticated: true, found: true, items }
      },
    }),
  ]
}

const pageItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    url: { type: 'string' },
    archived: { type: 'boolean' },
    createdTime: { type: 'string' },
    lastEditedTime: { type: 'string' },
    parentType: { type: 'string' },
    parentId: { type: 'string' },
    propertiesJson: { type: 'string' },
  },
} as const

interface JsonParseResult<T> {
  ok: boolean
  value?: T
  reason?: string
}

function parseJsonObject(value: string | undefined): JsonParseResult<Record<string, unknown>> {
  if (value === undefined || value.trim() === '') return { ok: true }
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> }
    }
    return { ok: false, reason: 'Expected a JSON object.' }
  } catch {
    return { ok: false, reason: 'Expected a valid JSON object.' }
  }
}

function parseJsonArray(value: string | undefined): JsonParseResult<unknown[]> {
  if (value === undefined || value.trim() === '') return { ok: true }
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return { ok: true, value: parsed }
    return { ok: false, reason: 'Expected a JSON array.' }
  } catch {
    return { ok: false, reason: 'Expected a valid JSON array.' }
  }
}

function buildChildren(
  childrenJson: string | undefined,
  content: string | undefined,
): JsonParseResult<unknown[]> {
  if (childrenJson && content) return { ok: false, reason: 'Provide only one of childrenJson or content.' }
  if (childrenJson) {
    const parsed = parseJsonArray(childrenJson)
    if (!parsed.ok) return parsed
    if (parsed.value?.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      return { ok: false, reason: 'childrenJson must contain only JSON block objects.' }
    }
    return { ok: true, value: parsed.value }
  }
  if (content !== undefined) {
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (lines.length === 0) return { ok: true, value: [] }
    return {
      ok: true,
      value: lines.map(line => ({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: line } }] },
      })),
    }
  }
  return { ok: true }
}

function renderPageList(items: Array<{ title?: string; url?: string; lastEditedTime?: string }>) {
  if (items.length === 0) return [{ type: 'text' as const, text: 'No Notion pages found.' }]
  return [{ type: 'text' as const, text: items.map(item =>
    `${item.title ?? '(untitled)'} ${item.url ?? ''} ${item.lastEditedTime ?? ''}`,
  ).join('\n') }]
}

function renderDatabaseList(items: Array<{ title?: string; url?: string }>) {
  if (items.length === 0) return [{ type: 'text' as const, text: 'No Notion databases found.' }]
  return [{ type: 'text' as const, text: items.map(item =>
    `${item.title ?? '(untitled)'} ${item.url ?? ''}`,
  ).join('\n') }]
}

function renderDatabaseSchema(value: { propertyCount?: number; propertiesJson?: string }) {
  const lines = [`${value.propertyCount ?? 0} database properties`]
  try {
    const properties = JSON.parse(value.propertiesJson ?? '[]') as Array<{
      name?: string
      type?: string
      options?: string[]
      detailsJson?: string
    }>
    for (const property of properties) {
      const options = property.options?.length ? ` options: ${property.options.join(', ')}` : ''
      const details = property.detailsJson ? ` details: ${property.detailsJson}` : ''
      lines.push(`- ${property.name ?? '(unnamed)'} (${property.type ?? 'unknown'})${options}${details}`)
    }
  } catch {
    lines.push('propertiesJson is not readable.')
  }
  return [{ type: 'text' as const, text: lines.join('\n') }]
}

function renderCommentList(items: Array<{ authorName?: string | null; createdTime?: string; text?: string }>) {
  if (items.length === 0) return [{ type: 'text' as const, text: 'No comments on this page.' }]
  return [{ type: 'text' as const, text: items.map(item =>
    `${item.authorName ?? 'unknown'} (${item.createdTime ?? ''}): ${item.text ?? ''}`,
  ).join('\n\n') }]
}

function renderUserList(items: Array<{ name?: string | null; email?: string | null; type?: string }>) {
  if (items.length === 0) return [{ type: 'text' as const, text: 'No Notion users found.' }]
  return [{ type: 'text' as const, text: items.map(item =>
    `${item.name ?? item.email ?? 'unknown'} (${item.type ?? ''})`,
  ).join('\n') }]
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return 20
  return Math.max(1, Math.min(value, 100))
}
