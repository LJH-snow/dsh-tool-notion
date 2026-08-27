import { describe, expect, it, vi } from 'vitest'
import { NotionClient, NotionError } from '../src/client.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const pageNode = {
  id: 'page-1',
  object: 'page',
  url: 'https://www.notion.so/Release-notes',
  archived: false,
  created_time: '2026-08-01T00:00:00.000Z',
  last_edited_time: '2026-08-02T00:00:00.000Z',
  parent: { type: 'page_id', page_id: 'parent-1' },
  properties: {
    title: { id: 'title', type: 'title', title: [{ plain_text: 'Release notes', text: { content: 'Release notes' } }] },
    Status: { id: 'status', type: 'status', status: { name: 'Done' } },
  },
}

const blockNode = {
  id: 'block-1',
  object: 'block',
  type: 'paragraph',
  has_children: false,
  paragraph: { rich_text: [{ plain_text: 'Hello', text: { content: 'Hello' } }] },
}

describe('NotionClient', () => {
  it('searches pages with bearer auth, version header, filter, and page size', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [pageNode] }))
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl })
    const items = await client.searchPages('release', { limit: 500 })

    expect(items[0]).toMatchObject({
      id: 'page-1',
      title: 'Release notes',
      url: 'https://www.notion.so/Release-notes',
      parentType: 'page_id',
      parentId: 'parent-1',
      propertiesJson: expect.stringContaining('Status'),
    })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.notion.com/v1/search')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      authorization: 'Bearer ntn_test',
      'notion-version': '2022-06-28',
    })
    expect(JSON.parse(String(init.body))).toEqual({
      query: 'release',
      filter: { value: 'page', property: 'object' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 100,
    })
  })

  it('gets a page and renders its readable block content', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(pageNode))
      .mockResolvedValueOnce(json({ results: [blockNode] }))
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl })
    const detail = await client.getPage('page-1')

    expect(detail).toMatchObject({
      id: 'page-1',
      title: 'Release notes',
      content: 'Hello',
      blockCount: 1,
    })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.notion.com/v1/pages/page-1')
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.notion.com/v1/blocks/page-1/children?page_size=100')
  })

  it('gets page metadata without fetching blocks', async () => {
    const fetchImpl = vi.fn(async () => json(pageNode))
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl })
    const detail = await client.getPage('page-1', { includeContent: false })
    expect(detail.blockCount).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('creates a page under a page parent with title and children', async () => {
    const fetchImpl = vi.fn(async () => json({ id: 'page-2', url: 'https://www.notion.so/New-page' }))
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl })
    const result = await client.createPage({
      parentPageId: 'parent-1',
      title: 'New page',
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'Hello' } }] } }],
    })

    expect(result).toEqual({ created: true, id: 'page-2', url: 'https://www.notion.so/New-page' })
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(body.parent).toEqual({ page_id: 'parent-1' })
    expect(body.properties.title.title[0].text.content).toBe('New page')
    expect(body.children).toHaveLength(1)
  })

  it('creates a database page from parsed properties and maps validation errors', async () => {
    const successFetch = vi.fn(async () => json({ id: 'page-3', url: 'https://www.notion.so/row' }))
    const successClient = new NotionClient({ apiToken: 'ntn_test', fetchImpl: successFetch })
    const result = await successClient.createPage({
      parentDatabaseId: 'db-1',
      properties: { Name: { title: [{ text: { content: 'Row name' } }] } },
    })
    expect(result.created).toBe(true)
    const body = JSON.parse(String((successFetch.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(body.parent).toEqual({ database_id: 'db-1' })
    expect(body.properties.Name.title[0].text.content).toBe('Row name')

    const errorFetch = vi.fn(async () => json({ message: 'Could not find database', code: 'validation_error' }, 404))
    const errorClient = new NotionClient({ apiToken: 'ntn_test', fetchImpl: errorFetch })
    await expect(errorClient.createPage({
      parentDatabaseId: 'missing',
      properties: { Name: { title: [{ text: { content: 'x' } }] } },
    })).resolves.toMatchObject({ created: false, reason: 'Could not find database' })
  })

  it('updates a page and appends blocks with the expected payloads', async () => {
    const updateFetch = vi.fn(async () => json({ id: 'page-1' }))
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl: updateFetch })
    const update = await client.updatePage('page-1', { title: 'Renamed' })
    const updateBody = JSON.parse(String((updateFetch.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(update).toEqual({ ok: true, id: 'page-1' })
    expect(updateBody.properties.title.title[0].text.content).toBe('Renamed')
    expect((updateFetch.mock.calls[0] as [string, RequestInit])[0]).toBe('https://api.notion.com/v1/pages/page-1')

    const appendFetch = vi.fn(async () => json({ results: [{ id: 'block-2' }] }))
    const appendClient = new NotionClient({ apiToken: 'ntn_test', fetchImpl: appendFetch })
    const append = await appendClient.appendBlocks('block-1', {
      children: [{ object: 'block', type: 'quote', quote: { rich_text: [{ text: { content: 'Quoted' } }] } }],
    })
    const appendBody = JSON.parse(String((appendFetch.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(append).toEqual({ ok: true, id: 'block-2' })
    expect(appendBody.children).toHaveLength(1)
  })

  it('lists databases and queries database rows', async () => {
    const databaseNode = {
      id: 'db-1',
      object: 'database',
      url: 'https://www.notion.so/db',
      archived: false,
      created_time: '2026-08-01T00:00:00.000Z',
      last_edited_time: '2026-08-02T00:00:00.000Z',
      title: [{ plain_text: 'Projects', text: { content: 'Projects' } }],
    }
    const dbFetch = vi.fn(async () => json({ results: [databaseNode] }))
    const dbClient = new NotionClient({ apiToken: 'ntn_test', fetchImpl: dbFetch })
    expect(await dbClient.listDatabases({ limit: 3 })).toMatchObject([{ id: 'db-1', title: 'Projects' }])
    expect(JSON.parse(String((dbFetch.mock.calls[0] as [string, RequestInit])[1]?.body)).filter).toEqual({
      value: 'database',
      property: 'object',
    })

    const queryFetch = vi.fn(async () => json({ results: [pageNode] }))
    const queryClient = new NotionClient({ apiToken: 'ntn_test', fetchImpl: queryFetch })
    const rows = await queryClient.queryDatabase('db-1', {
      filter: { property: 'Status', status: { equals: 'Done' } },
      sorts: [{ property: 'Last edited time', direction: 'descending' }],
      limit: 50,
    })
    expect(rows[0]).toMatchObject({ id: 'page-1', title: 'Release notes' })
    expect(JSON.parse(String((queryFetch.mock.calls[0] as [string, RequestInit])[1]?.body))).toEqual({
      filter: { property: 'Status', status: { equals: 'Done' } },
      sorts: [{ property: 'Last edited time', direction: 'descending' }],
      page_size: 50,
    })
  })

  it('lists and creates comments', async () => {
    const commentNode = {
      id: 'comment-1',
      created_time: '2026-08-02T00:00:00.000Z',
      rich_text: [{ plain_text: 'Looks good', text: { content: 'Looks good' } }],
      author: { name: 'Alice', type: 'person' },
      parent: { type: 'page_id', page_id: 'page-1' },
    }
    const listFetch = vi.fn(async () => json({ results: [commentNode] }))
    const comments = new NotionClient({ apiToken: 'ntn_test', fetchImpl: listFetch })
    expect(await comments.listPageComments('page-1')).toMatchObject([
      { id: 'comment-1', text: 'Looks good', authorName: 'Alice', parentId: 'page-1' },
    ])
    expect(listFetch.mock.calls[0][0]).toBe('https://api.notion.com/v1/comments?block_id=page-1')

    const createFetch = vi.fn(async () => json({ id: 'comment-2' }))
    const createClient = new NotionClient({ apiToken: 'ntn_test', fetchImpl: createFetch })
    const created = await createClient.addComment('page-1', 'Please review')
    expect(created).toEqual({ ok: true, id: 'comment-2' })
    const body = JSON.parse(String((createFetch.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(body.parent).toEqual({ page_id: 'page-1' })
    expect(body.rich_text[0].text.content).toBe('Please review')
  })

  it('lists users and maps person and bot fields', async () => {
    const fetchImpl = vi.fn(async () => json({
      results: [
        { id: 'user-1', type: 'person', name: 'Alice', avatar_url: 'https://example.com/a.png', person: { email: 'alice@example.com' } },
        { id: 'bot-1', type: 'bot', name: 'Harness', avatar_url: null, bot: { workspace_name: 'Default' } },
      ],
    }))
    const client = new NotionClient({ apiToken: 'ntn_test', fetchImpl })
    const users = await client.listUsers({ limit: 50 })
    expect(users).toMatchObject([
      { id: 'user-1', email: 'alice@example.com', botWorkspaceName: null },
      { id: 'bot-1', botWorkspaceName: 'Default', email: null },
    ])
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.notion.com/v1/users?page_size=50')
  })

  it('throws infrastructure errors and keeps validation errors as business values', async () => {
    const authFetch = vi.fn(async () => json({ message: 'Invalid token', code: 'unauthorized' }, 401))
    await expect(new NotionClient({ apiToken: 'bad', fetchImpl: authFetch }).searchPages('x'))
      .rejects.toThrow(NotionError)

    const badInputFetch = vi.fn(async () => json({ message: 'Bad property value', code: 'validation_error' }, 400))
    const result = await new NotionClient({ apiToken: 'ntn_test', fetchImpl: badInputFetch }).createPage({
      parentPageId: 'parent-1',
      title: 'x',
    })
    expect(result).toMatchObject({ created: false, reason: 'Bad property value' })
  })
})
