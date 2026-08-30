/** Minimal Notion REST API client with injected fetch for testability. */

export interface NotionClientOptions {
  /** Notion internal integration token, usually starts with ntn_. */
  apiToken?: string
  /** REST API endpoint override, default https://api.notion.com. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Notion API version header, default 2022-06-28. */
  notionVersion?: string
  /** Request timeout in milliseconds. 0 disables the timeout. */
  timeoutMs?: number
}

export interface NotionPageSummary {
  id: string
  title: string
  url: string
  archived: boolean
  createdTime: string
  lastEditedTime: string
  parentType: string
  parentId: string
  propertiesJson: string
}

export interface NotionListResult<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

export interface NotionPageDetail extends NotionPageSummary {
  content: string
  blockCount: number
}

export interface NotionDatabaseSummary {
  id: string
  title: string
  url: string
  archived: boolean
  createdTime: string
  lastEditedTime: string
}

export interface NotionDatabaseSchema extends NotionDatabaseSummary {
  propertyCount: number
  propertiesJson: string
}

export interface NotionDatabaseSchemaProperty {
  id: string
  name: string
  type: string
  options: string[]
  detailsJson: string
}

export interface NotionCommentItem {
  id: string
  text: string
  authorName: string | null
  createdTime: string
  parentType: string | null
  parentId: string | null
}

export interface NotionUser {
  id: string
  type: string
  name: string | null
  avatarUrl: string | null
  email: string | null
  botWorkspaceName: string | null
}

export interface NotionCreateResult {
  created: boolean
  id?: string
  url?: string
  reason?: string
}

export interface NotionWriteResult {
  ok: boolean
  id?: string
  reason?: string
}

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'NotionError'
  }
}

interface RawText {
  plain_text?: string
  text?: { content?: string }
}

interface RawProperty {
  id?: string
  type?: string
  title?: RawText[]
  rich_text?: RawText[]
  [key: string]: unknown
}

interface RawParent {
  type?: string
  page_id?: string
  database_id?: string
  [key: string]: unknown
}

interface RawPage {
  id: string
  object: 'page' | string
  url?: string
  archived?: boolean
  created_time?: string
  last_edited_time?: string
  parent?: RawParent | null
  properties?: Record<string, RawProperty>
}

interface RawDatabase {
  id: string
  object: 'database' | string
  url?: string
  archived?: boolean
  created_time?: string
  last_edited_time?: string
  title?: RawText[]
  properties?: Record<string, RawDatabaseProperty>
}

interface RawDatabaseProperty {
  id?: string
  name?: string
  type?: string
  [key: string]: unknown
}

interface RawComment {
  id: string
  created_time?: string
  rich_text?: RawText[]
  author?: {
    name?: string | null
    type?: string
    person?: { email?: string }
  } | null
  parent?: RawParent | null
}

interface RawUser {
  id: string
  type?: string
  name?: string | null
  avatar_url?: string | null
  person?: { email?: string }
  bot?: { workspace_name?: string }
}

interface RawBlock {
  id: string
  type: string
  archived?: boolean
  has_children?: boolean
  [key: string]: unknown
}

interface ErrorPayload {
  message?: string
  code?: string
}

function textFromRichText(items?: RawText[]): string {
  return (items ?? [])
    .map(item => item.plain_text ?? item.text?.content ?? '')
    .join('')
}

function extractPageTitle(properties?: Record<string, RawProperty>): string {
  const titleProperty = Object.values(properties ?? {}).find(property => property.type === 'title')
  return textFromRichText(titleProperty?.title)
}

function mapPageSummary(raw: RawPage): NotionPageSummary {
  const parent = raw.parent ?? {}
  const parentType = parent.type ?? ''
  const parentId = parentType && typeof parent[parentType] === 'string'
    ? String(parent[parentType])
    : ''
  return {
    id: raw.id,
    title: extractPageTitle(raw.properties),
    url: raw.url ?? '',
    archived: raw.archived ?? false,
    createdTime: raw.created_time ?? '',
    lastEditedTime: raw.last_edited_time ?? '',
    parentType,
    parentId,
    propertiesJson: JSON.stringify(raw.properties ?? {}),
  }
}

function mapDatabase(raw: RawDatabase): NotionDatabaseSummary {
  return {
    id: raw.id,
    title: textFromRichText(raw.title),
    url: raw.url ?? '',
    archived: raw.archived ?? false,
    createdTime: raw.created_time ?? '',
    lastEditedTime: raw.last_edited_time ?? '',
  }
}

function propertyOptions(raw: RawDatabaseProperty): string[] {
  const type = raw.type
  const detail = type && typeof raw[type] === 'object' && raw[type] !== null
    ? raw[type] as Record<string, unknown>
    : undefined
  if (!detail || !Array.isArray(detail.options)) return []
  return detail.options.map(option => {
    if (typeof option === 'string') return option
    if (option && typeof option === 'object' && typeof (option as { name?: unknown }).name === 'string') {
      return (option as { name: string }).name
    }
    return ''
  }).filter(Boolean)
}

function propertyDetails(raw: RawDatabaseProperty): string {
  const type = raw.type
  const detail = type && typeof raw[type] === 'object' && raw[type] !== null
    ? { ...raw[type] as Record<string, unknown> }
    : undefined
  if (!detail) return ''
  delete detail.options
  return Object.keys(detail).length > 0 ? JSON.stringify(detail) : ''
}

function mapDatabaseSchema(raw: RawDatabase): NotionDatabaseSchema {
  const normalized = Object.entries(raw.properties ?? {}).map(([name, property]) => ({
    id: property.id ?? '',
    name,
    type: property.type ?? 'unknown',
    options: propertyOptions(property),
    detailsJson: propertyDetails(property),
  }))
  return {
    ...mapDatabase(raw),
    propertyCount: normalized.length,
    propertiesJson: JSON.stringify(normalized),
  }
}

function mapComment(raw: RawComment): NotionCommentItem {
  const parent = raw.parent ?? {}
  const parentType = parent.type ?? null
  const parentId = parentType && typeof parent[parentType] === 'string'
    ? String(parent[parentType])
    : null
  return {
    id: raw.id,
    text: textFromRichText(raw.rich_text),
    authorName: raw.author?.name ?? raw.author?.person?.email ?? null,
    createdTime: raw.created_time ?? '',
    parentType,
    parentId,
  }
}

function mapUser(raw: RawUser): NotionUser {
  return {
    id: raw.id,
    type: raw.type ?? 'unknown',
    name: raw.name ?? null,
    avatarUrl: raw.avatar_url ?? null,
    email: raw.person?.email ?? null,
    botWorkspaceName: raw.bot?.workspace_name ?? null,
  }
}

function blockText(block: RawBlock): string {
  const child = block[block.type]
  if (child && typeof child === 'object') {
    const richText = (child as { rich_text?: RawText[] }).rich_text
    if (Array.isArray(richText)) return textFromRichText(richText)
  }
  return textFromRichText(block.rich_text as RawText[] | undefined)
}

function formatBlock(block: RawBlock): string {
  if (block.archived) return ''
  const text = blockText(block)
  switch (block.type) {
    case 'heading_1':
      return text ? `# ${text}` : text
    case 'heading_2':
      return text ? `## ${text}` : text
    case 'heading_3':
      return text ? `### ${text}` : text
    case 'bulleted_list_item':
      return text ? `- ${text}` : text
    case 'numbered_list_item':
      return text ? `1. ${text}` : text
    case 'to_do': {
      const checked = (block.to_do as { checked?: boolean } | undefined)?.checked
      return text ? `${checked ? '[x]' : '[ ]'} ${text}` : text
    }
    case 'quote':
      return text ? `> ${text}` : text
    case 'code': {
      const language = (block.code as { language?: string } | undefined)?.language
      return text ? `\`\`\`${language ?? ''}\n${text}\n\`\`\`` : text
    }
    case 'divider':
      return '---'
    case 'child_page':
      return text ? `[[${text}]]` : ''
    case 'bookmark':
      return text ? `[${text}]` : ''
    case 'image': {
      const caption = textFromRichText((block.image as { caption?: RawText[] } | undefined)?.caption)
      return caption ? `![${caption}]` : ''
    }
    case 'unsupported':
      return '[unsupported block]'
    default:
      return text
  }
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return 20
  return Math.max(1, Math.min(value, 100))
}

function isInfrastructureError(error: NotionError): boolean {
  return error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500
}

export class NotionClient {
  private readonly apiToken: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly notionVersion: string
  private readonly timeoutMs: number

  constructor(options: NotionClientOptions = {}) {
    this.apiToken = options.apiToken ?? ''
    this.baseUrl = (options.baseUrl ?? 'https://api.notion.com').replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.notionVersion = options.notionVersion ?? '2022-06-28'
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  hasToken(): boolean {
    return this.apiToken.length > 0
  }

  private combinedSignal(signal?: AbortSignal): AbortSignal | undefined {
    if (this.timeoutMs <= 0) return signal
    const timeout = AbortSignal.timeout(this.timeoutMs)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/json',
      authorization: `Bearer ${this.apiToken}`,
      'content-type': 'application/json',
      'notion-version': this.notionVersion,
      'user-agent': 'dsh-tool-notion',
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.combinedSignal(signal),
    })

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      payload = undefined
    }

    if (!response.ok) {
      const errorPayload = payload as ErrorPayload | undefined
      const message = errorPayload?.message ?? `Notion API HTTP error ${response.status}`
      throw new NotionError(message, response.status, errorPayload?.code)
    }
    if (payload === undefined) throw new NotionError('Notion API returned a non-JSON response', 502)
    return payload as T
  }

  async searchPages(
    query: string,
    options: { limit?: number; startCursor?: string; signal?: AbortSignal } = {},
  ): Promise<NotionListResult<NotionPageSummary>> {
    const data = await this.request<{ results?: RawPage[]; next_cursor?: string | null; has_more?: boolean }>(
      'POST',
      '/v1/search',
      {
        ...(query ? { query } : {}),
        filter: { value: 'page', property: 'object' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        ...(options.startCursor ? { start_cursor: options.startCursor } : {}),
        page_size: clampLimit(options.limit ?? 20),
      },
      options.signal,
    )
    return {
      items: (data.results ?? []).filter(page => page.object === 'page').map(mapPageSummary),
      nextCursor: data.next_cursor ?? null,
      hasMore: data.has_more ?? false,
    }
  }

  private async collectBlockLines(
    blockId: string,
    lines: string[],
    depth: number,
    budget: { count: number },
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const data = await this.request<{ results?: RawBlock[] }>(
      'GET',
      `/v1/blocks/${encodeURIComponent(blockId)}/children?page_size=100`,
      undefined,
      signal,
    )
    for (const block of data.results ?? []) {
      if (budget.count >= 300) break
      const rendered = formatBlock(block)
      if (rendered) {
        lines.push(`${'  '.repeat(depth)}${rendered}`)
        budget.count += 1
      }
      if (block.has_children && depth < 2) {
        await this.collectBlockLines(block.id, lines, depth + 1, budget, signal)
      }
    }
  }

  async getPage(
    id: string,
    options: { includeContent?: boolean; signal?: AbortSignal } = {},
  ): Promise<NotionPageDetail> {
    const page = await this.request<RawPage>('GET', `/v1/pages/${encodeURIComponent(id)}`, undefined, options.signal)
    const summary = mapPageSummary(page)
    if (options.includeContent === false) {
      return { ...summary, content: '', blockCount: 0 }
    }
    const lines: string[] = []
    const budget = { count: 0 }
    await this.collectBlockLines(page.id, lines, 0, budget, options.signal)
    return { ...summary, content: lines.join('\n'), blockCount: budget.count }
  }

  async createPage(input: {
    parentPageId?: string
    parentDatabaseId?: string
    title?: string
    properties?: Record<string, unknown>
    children?: unknown[]
    signal?: AbortSignal
  }): Promise<NotionCreateResult> {
    try {
      if (input.parentPageId && input.parentDatabaseId) {
        return { created: false, reason: 'Provide exactly one of parentPageId or parentDatabaseId.' }
      }
      let properties: Record<string, unknown>
      if (input.parentPageId) {
        properties = {
          title: { title: [{ text: { content: input.title ?? '' } }] },
          ...input.properties,
        }
      } else {
        if (!input.properties || Object.keys(input.properties).length === 0) {
          return { created: false, reason: 'A database page requires propertiesJson.' }
        }
        properties = input.properties
      }
      const data = await this.request<{ id: string; url?: string }>(
        'POST',
        '/v1/pages',
        {
          parent: input.parentPageId
            ? { page_id: input.parentPageId }
            : { database_id: input.parentDatabaseId },
          properties,
          ...(input.children?.length ? { children: input.children } : {}),
        },
        input.signal,
      )
      return { created: true, id: data.id, url: data.url }
    } catch (error) {
      if (error instanceof NotionError && isInfrastructureError(error)) throw error
      return { created: false, reason: error instanceof NotionError ? error.message : 'Could not create the Notion page.' }
    }
  }

  async updatePage(
    id: string,
    input: {
      archived?: boolean
      title?: string
      properties?: Record<string, unknown>
      signal?: AbortSignal
    },
  ): Promise<NotionWriteResult> {
    try {
      const body: Record<string, unknown> = {}
      if (input.archived !== undefined) body.archived = input.archived
      if (input.title !== undefined) {
        body.properties = {
          ...(input.properties ?? {}),
          title: { title: [{ text: { content: input.title } }] },
        }
      } else if (input.properties !== undefined) {
        body.properties = input.properties
      }
      const data = await this.request<{ id: string }>(
        'PATCH',
        `/v1/pages/${encodeURIComponent(id)}`,
        body,
        input.signal,
      )
      return { ok: true, id: data.id }
    } catch (error) {
      if (error instanceof NotionError && isInfrastructureError(error)) throw error
      return { ok: false, id, reason: error instanceof NotionError ? error.message : 'Could not update the Notion page.' }
    }
  }

  async appendBlocks(
    blockId: string,
    input: { children: unknown[]; signal?: AbortSignal },
  ): Promise<NotionWriteResult> {
    try {
      const data = await this.request<{ results?: Array<{ id: string }> }>(
        'PATCH',
        `/v1/blocks/${encodeURIComponent(blockId)}/children`,
        { children: input.children },
        input.signal,
      )
      const appended = (data.results ?? [])[0]
      return appended ? { ok: true, id: appended.id } : { ok: true }
    } catch (error) {
      if (error instanceof NotionError && isInfrastructureError(error)) throw error
      return { ok: false, reason: error instanceof NotionError ? error.message : 'Could not append Notion blocks.' }
    }
  }

  async listDatabases(
    options: { limit?: number; startCursor?: string; signal?: AbortSignal } = {},
  ): Promise<NotionListResult<NotionDatabaseSummary>> {
    const data = await this.request<{ results?: RawDatabase[]; next_cursor?: string | null; has_more?: boolean }>(
      'POST',
      '/v1/search',
      {
        filter: { value: 'database', property: 'object' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        ...(options.startCursor ? { start_cursor: options.startCursor } : {}),
        page_size: clampLimit(options.limit ?? 20),
      },
      options.signal,
    )
    return {
      items: (data.results ?? []).filter(database => database.object === 'database').map(mapDatabase),
      nextCursor: data.next_cursor ?? null,
      hasMore: data.has_more ?? false,
    }
  }

  async getDatabase(
    databaseId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<NotionDatabaseSchema> {
    const data = await this.request<RawDatabase>(
      'GET',
      `/v1/databases/${encodeURIComponent(databaseId)}`,
      undefined,
      options.signal,
    )
    return mapDatabaseSchema(data)
  }

  async queryDatabase(
    databaseId: string,
    options: {
      filter?: Record<string, unknown>
      sorts?: unknown[]
      limit?: number
      startCursor?: string
      signal?: AbortSignal
    } = {},
  ): Promise<NotionListResult<NotionPageSummary>> {
    const data = await this.request<{ results?: RawPage[]; next_cursor?: string | null; has_more?: boolean }>(
      'POST',
      `/v1/databases/${encodeURIComponent(databaseId)}/query`,
      {
        page_size: clampLimit(options.limit ?? 20),
        ...(options.startCursor ? { start_cursor: options.startCursor } : {}),
        ...(options.filter ? { filter: options.filter } : {}),
        ...(options.sorts?.length ? { sorts: options.sorts } : {}),
      },
      options.signal,
    )
    return {
      items: (data.results ?? []).map(mapPageSummary),
      nextCursor: data.next_cursor ?? null,
      hasMore: data.has_more ?? false,
    }
  }

  async listPageComments(
    pageId: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<NotionCommentItem[]> {
    const data = await this.request<{ results?: RawComment[] }>(
      'GET',
      `/v1/comments?block_id=${encodeURIComponent(pageId)}`,
      undefined,
      options.signal,
    )
    const limit = clampLimit(options.limit ?? 20)
    return (data.results ?? []).slice(0, limit).map(mapComment)
  }

  async addComment(pageId: string, text: string, signal?: AbortSignal): Promise<NotionWriteResult> {
    try {
      const data = await this.request<{ id: string }>(
        'POST',
        '/v1/comments',
        {
          parent: { page_id: pageId },
          rich_text: [{ type: 'text', text: { content: text } }],
        },
        signal,
      )
      return { ok: true, id: data.id }
    } catch (error) {
      if (error instanceof NotionError && isInfrastructureError(error)) throw error
      return { ok: false, reason: error instanceof NotionError ? error.message : 'Could not add the Notion comment.' }
    }
  }

  async listUsers(
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<NotionUser[]> {
    const data = await this.request<{ results?: RawUser[] }>(
      'GET',
      `/v1/users?page_size=${clampLimit(options.limit ?? 20)}`,
      undefined,
      options.signal,
    )
    return (data.results ?? []).map(mapUser)
  }
}
