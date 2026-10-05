import { describe, expect, it, vi } from 'vitest'
import { NotionClient, NotionError } from '../src/client.ts'

/** Deterministic DNS so tests never depend on real resolution. */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }]


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

const databaseSchemaNode = {
  id: 'db-1',
  object: 'database',
  url: 'https://www.notion.so/db',
  archived: false,
  created_time: '2026-08-01T00:00:00.000Z',
  last_edited_time: '2026-08-02T00:00:00.000Z',
  title: [{ plain_text: 'Projects', text: { content: 'Projects' } }],
  properties: {
    Name: { id: 'title', name: 'Name', type: 'title', title: {} },
    Status: {
      id: 'status',
      name: 'Status',
      type: 'status',
      status: { options: [{ name: 'Done', color: 'green' }, { name: 'In Progress', color: 'blue' }] },
    },
    Owner: {
      id: 'owner',
      name: 'Owner',
      type: 'relation',
      relation: { database_id: 'db-2', synced_property_name: 'Key', synced_property_id: 'key' },
    },
  },
}

describe('NotionClient', () => {
  it('searches pages with bearer auth, version header, filter, page size, and cursor', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [pageNode], next_cursor: 'cursor-2', has_more: true }))
    const client = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl })
    const result = await client.searchPages('release', { limit: 500, startCursor: 'cursor-1' })

    expect(result.items[0]).toMatchObject({
      id: 'page-1',
      title: 'Release notes',
      url: 'https://www.notion.so/Release-notes',
      parentType: 'page_id',
      parentId: 'parent-1',
      propertiesJson: expect.stringContaining('Status'),
    })
    expect(result.nextCursor).toBe('cursor-2')
    expect(result.hasMore).toBe(true)
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
      start_cursor: 'cursor-1',
      page_size: 100,
    })
  })

  it('gets a page and renders its readable block content', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(pageNode))
      .mockResolvedValueOnce(json({ results: [blockNode] }))
    const client = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl })
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
    const client = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl })
    const detail = await client.getPage('page-1', { includeContent: false })
    expect(detail.blockCount).toBe(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('creates a page under a page parent with title and children', async () => {
    const fetchImpl = vi.fn(async () => json({ id: 'page-2', url: 'https://www.notion.so/New-page' }))
    const client = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl })
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
    const successClient = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl: successFetch })
    const result = await successClient.createPage({
      parentDatabaseId: 'db-1',
      properties: { Name: { title: [{ text: { content: 'Row name' } }] } },
    })
    expect(result.created).toBe(true)
    const body = JSON.parse(String((successFetch.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(body.parent).toEqual({ database_id: 'db-1' })
    expect(body.properties.Name.title[0].text.content).toBe('Row name')

    const errorFetch = vi.fn(async () => json({ message: 'Could not find database', code: 'validation_error' }, 404))
    const errorClient = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl: errorFetch })
    await expect(errorClient.createPage({
      parentDatabaseId: 'missing',
      properties: { Name: { title: [{ text: { content: 'x' } }] } },
    })).resolves.toMatchObject({ created: false, reason: 'Could not find database' })
  })

  it('updates a page and appends blocks with the expected payloads', async () => {
    const updateFetch = vi.fn(async () => json({ id: 'page-1' }))
    const client = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl: updateFetch })
    const update = await client.updatePage('page-1', { title: 'Renamed' })
    const updateBody = JSON.parse(String((updateFetch.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(update).toEqual({ ok: true, id: 'page-1' })
    expect(updateBody.properties.title.title[0].text.content).toBe('Renamed')
    expect((updateFetch.mock.calls[0] as [string, RequestInit])[0]).toBe('https://api.notion.com/v1/pages/page-1')

    const appendFetch = vi.fn(async () => json({ results: [{ id: 'block-2' }] }))
    const appendClient = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl: appendFetch })
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
    const dbFetch = vi.fn(async () => json({ results: [databaseNode], next_cursor: 'db-next', has_more: true }))
    const dbClient = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl: dbFetch })
    const databases = await dbClient.listDatabases({ limit: 3, startCursor: 'db-cursor' })
    expect(databases).toMatchObject({ items: [{ id: 'db-1', title: 'Projects' }], nextCursor: 'db-next', hasMore: true })
    const dbBody = JSON.parse(String((dbFetch.mock.calls[0] as [string, RequestInit])[1]?.body))
    expect(dbBody.filter).toEqual({ value: 'database', property: 'object' })
    expect(dbBody.start_cursor).toBe('db-cursor')

    const queryFetch = vi.fn(async () => json({ results: [pageNode], next_cursor: 'query-next', has_more: false }))
    const queryClient = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl: queryFetch })
    const rows = await queryClient.queryDatabase('db-1', {
      filter: { property: 'Status', status: { equals: 'Done' } },
      sorts: [{ property: 'Last edited time', direction: 'descending' }],
      limit: 50,
      startCursor: 'query-cursor',
    })
    expect(rows.items[0]).toMatchObject({ id: 'page-1', title: 'Release notes' })
    expect(rows.nextCursor).toBe('query-next')
    expect(rows.hasMore).toBe(false)
    expect(JSON.parse(String((queryFetch.mock.calls[0] as [string, RequestInit])[1]?.body))).toEqual({
      filter: { property: 'Status', status: { equals: 'Done' } },
      sorts: [{ property: 'Last edited time', direction: 'descending' }],
      start_cursor: 'query-cursor',
      page_size: 50,
    })
  })

  it('gets a database schema and normalizes property options and details', async () => {
    const fetchImpl = vi.fn(async () => json(databaseSchemaNode))
    const client = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl })
    const schema = await client.getDatabase('db-1')

    expect(schema).toMatchObject({
      id: 'db-1',
      title: 'Projects',
      propertyCount: 3,
    })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.notion.com/v1/databases/db-1')
    expect(JSON.parse(schema.propertiesJson)).toEqual([
      { id: 'title', name: 'Name', type: 'title', options: [], detailsJson: '' },
      { id: 'status', name: 'Status', type: 'status', options: ['Done', 'In Progress'], detailsJson: '' },
      {
        id: 'owner',
        name: 'Owner',
        type: 'relation',
        options: [],
        detailsJson: JSON.stringify({ database_id: 'db-2', synced_property_name: 'Key', synced_property_id: 'key' }),
      },
    ])
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
    const comments = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl: listFetch })
    expect(await comments.listPageComments('page-1')).toMatchObject([
      { id: 'comment-1', text: 'Looks good', authorName: 'Alice', parentId: 'page-1' },
    ])
    expect(listFetch.mock.calls[0][0]).toBe('https://api.notion.com/v1/comments?block_id=page-1')

    const createFetch = vi.fn(async () => json({ id: 'comment-2' }))
    const createClient = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl: createFetch })
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
    const client = new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl })
    const users = await client.listUsers({ limit: 50 })
    expect(users).toMatchObject([
      { id: 'user-1', email: 'alice@example.com', botWorkspaceName: null },
      { id: 'bot-1', botWorkspaceName: 'Default', email: null },
    ])
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.notion.com/v1/users?page_size=50')
  })

  it('throws infrastructure errors and keeps validation errors as business values', async () => {
    const authFetch = vi.fn(async () => json({ message: 'Invalid token', code: 'unauthorized' }, 401))
    await expect(new NotionClient({ lookupImpl: publicLookup, apiToken: 'bad', fetchImpl: authFetch }).searchPages('x'))
      .rejects.toThrow(NotionError)

    const badInputFetch = vi.fn(async () => json({ message: 'Bad property value', code: 'validation_error' }, 400))
    const result = await new NotionClient({ lookupImpl: publicLookup, apiToken: 'ntn_test', fetchImpl: badInputFetch }).createPage({
      parentPageId: 'parent-1',
      title: 'x',
    })
    expect(result).toMatchObject({ created: false, reason: 'Bad property value' })
  })
})

describe('Notion endpoint security', () => {
  const valid = { apiToken: 'ntn_test' }

  it('rejects invalid base URLs without exposing their contents', () => {
    for (const baseUrl of [
      'api.notion.com',
      'ftp://api.notion.com',
      'https://user:secretapi.notion.com',
      'https://api.notion.com?token=secret',
      'https://api.notion.com#fragment',
    ]) {
      let error: unknown
      try { new NotionClient({ ...valid, baseUrl }) } catch (thrown) { error = thrown }
      expect(error).toBeInstanceOf(NotionError)
      expect(String(error)).not.toContain('secret')
    }
  })

  it('rejects literal local, private, and reserved addresses before fetch', async () => {
    for (const baseUrl of [
      'http://localhost',
      'http://service.localhost',
      'http://service.local',
      'http://127.0.0.1',
      'http://169.254.169.254',
      'http://10.0.0.1',
      'http://192.168.1.1',
      'http://192.0.2.1',
      'http://198.18.0.1',
      'http://224.0.0.1',
      'http://192.175.48.1',
      'http://[::1]',
      'http://[fc00::1]',
      'http://[fe80::1]',
      'http://[fec0::1]',
      'http://[2001:db8::1]',
      'http://[2001:3::1]',
      'http://[2001:4:112::1]',
      'http://[2001:30::1]',
      'http://[5f00::1]',
      'http://[100:0:0:1::1]',
      'http://[2620:4f:8000::1]',
      'http://[64:ff9b::7f00:1]',
      'http://[ff02::1]',
    ]) {
      const fetchImpl = vi.fn()
      await expect(new NotionClient({ ...valid, baseUrl, fetchImpl }).listUsers()).rejects.toMatchObject({ name: 'NotionError' })
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('fails closed on blocked, failed, empty, or inconsistent DNS results', async () => {
    for (const lookupImpl of [
      async () => [{ address: '192.168.1.10', family: 4 as const }],
      async () => [{ address: '93.184.216.34', family: 4 as const }, { address: '169.254.169.254', family: 4 as const }],
      async () => { throw new Error('dns failure') },
      async () => [],
      async () => [{ address: '2001:db8::1', family: 4 as const }],
    ]) {
      const fetchImpl = vi.fn()
      await expect(new NotionClient({ ...valid, baseUrl: 'https://notion.example.test', fetchImpl, lookupImpl }).listUsers()).rejects.toMatchObject({ name: 'NotionError' })
      expect(fetchImpl).not.toHaveBeenCalled()
    }
  })

  it('allows a public endpoint that resolves to a public address', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    await new NotionClient({ ...valid, baseUrl: 'https://notion.example.test', fetchImpl, lookupImpl: publicLookup }).listUsers().catch(() => undefined)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
