import { describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { NotionClient } from '../src/client.ts'
import { createTools } from '../src/index.ts'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function exec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

function tools(client = new NotionClient({ fetchImpl: globalThis.fetch })) {
  return Object.fromEntries(createTools(client).map(tool => [tool.name, tool]))
}

const pageNode = {
  id: 'page-1',
  object: 'page',
  url: 'https://www.notion.so/Release-notes',
  archived: false,
  created_time: '2026-08-01T00:00:00.000Z',
  last_edited_time: '2026-08-02T00:00:00.000Z',
  parent: { type: 'page_id', page_id: 'parent-1' },
  properties: { title: { type: 'title', title: [{ plain_text: 'Release notes', text: { content: 'Release notes' } }] } },
}

describe('tool definitions', () => {
  it('registers the planned Notion tool set', () => {
    expect(Object.keys(tools()).sort()).toEqual([
      'notion_add_comment',
      'notion_append_blocks',
      'notion_create_page',
      'notion_get_page',
      'notion_list_databases',
      'notion_list_page_comments',
      'notion_list_users',
      'notion_query_database',
      'notion_search_pages',
      'notion_update_page',
    ])
  })

  it('returns business values without an integration token', async () => {
    const map = tools()
    expect(await map.notion_search_pages.execute({ query: 'docs' }, exec())).toMatchObject({
      authenticated: false,
      items: [],
    })
    expect(await map.notion_get_page.execute({ id: 'page-1' }, exec())).toMatchObject({ authenticated: false, found: false })
    expect(await map.notion_create_page.execute({ parentPageId: 'parent-1', title: 'x' }, exec())).toMatchObject({ created: false })
    expect(await map.notion_update_page.execute({ id: 'page-1', title: 'x' }, exec())).toMatchObject({ ok: false })
    expect(await map.notion_append_blocks.execute({ blockId: 'page-1', content: 'x' }, exec())).toMatchObject({ ok: false })
    expect(await map.notion_add_comment.execute({ pageId: 'page-1', text: 'x' }, exec())).toMatchObject({ ok: false })
  })

  it('search_pages executes with a token and forwards the request body', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [pageNode] }))
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl })
    const map = tools(client)
    const result = await map.notion_search_pages.execute({ query: 'release', limit: 500 }, exec())
    expect(result).toMatchObject({ authenticated: true, found: true, items: [{ title: 'Release notes' }] })
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(body).toMatchObject({ query: 'release', page_size: 100, filter: { value: 'page', property: 'object' } })
  })

  it('create_page validates parents and forwards properties and children', async () => {
    const fetchImpl = vi.fn(async () => json({ id: 'page-2', url: 'https://www.notion.so/new' }))
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl })
    const map = tools(client)
    const result = await map.notion_create_page.execute({
      parentPageId: 'parent-1',
      title: 'New page',
      content: 'Line one\nLine two',
    }, exec())
    expect(result).toMatchObject({ created: true, id: 'page-2' })
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(body.parent).toEqual({ page_id: 'parent-1' })
    expect(body.children).toHaveLength(2)

    const missing = await map.notion_create_page.execute({ parentDatabaseId: 'db-1' }, exec())
    expect(missing).toMatchObject({ created: false, reason: 'A database page requires propertiesJson.' })
  })

  it('update_page rejects invalid propertiesJson', async () => {
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl: vi.fn() })
    const map = tools(client)
    const result = await map.notion_update_page.execute({ id: 'page-1', propertiesJson: 'not json' }, exec())
    expect(result).toMatchObject({ ok: false, reason: 'propertiesJson must be a valid JSON object.' })
  })

  it('query_database parses filter and sorts JSON', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [pageNode] }))
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl })
    const map = tools(client)
    const result = await map.notion_query_database.execute({
      databaseId: 'db-1',
      filterJson: '{"property":"Status","status":{"equals":"Done"}}',
      sortsJson: '[{"property":"Last edited time","direction":"descending"}]',
    }, exec())
    expect(result).toMatchObject({ authenticated: true, found: true, items: [{ title: 'Release notes' }] })
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(body.filter).toEqual({ property: 'Status', status: { equals: 'Done' } })
    expect(body.sorts).toEqual([{ property: 'Last edited time', direction: 'descending' }])
  })

  it('render produces readable page text from the canonical value', async () => {
    const map = tools()
    const blocks = await (map.notion_search_pages.output as { render: (a: unknown, v: any) => unknown }).render({}, {
      authenticated: true,
      found: true,
      items: [{ title: 'Release notes', url: 'https://www.notion.so/Release-notes', lastEditedTime: '2026-08-02' }],
    })
    expect(JSON.stringify(blocks)).toContain('Release notes https://www.notion.so/Release-notes 2026-08-02')
  })

  it('presents page search and write cards', () => {
    const map = tools()
    expect(map.notion_search_pages.presentCall!({ query: 'release' })).toMatchObject({ card: 'generic', kind: 'search' })
    expect(map.notion_get_page.presentCall!({ id: 'page-1' })).toMatchObject({ card: 'generic', kind: 'read' })
    expect(map.notion_get_page.presentResult!({ id: 'page-1' }, { authenticated: true, found: false })).toMatchObject({ title: 'Page not found' })
    expect(map.notion_create_page.presentCall!({ parentPageId: 'parent-1', title: 'x' })).toMatchObject({ card: 'generic', kind: 'edit' })
    expect(map.notion_create_page.presentResult!({ parentPageId: 'parent-1', title: 'x' }, { created: true, id: 'page-2' })).toMatchObject({ title: 'Notion page page-2 created' })
  })
})
