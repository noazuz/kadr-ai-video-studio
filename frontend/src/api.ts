import type { Account, Draft, Expense, ExpensePage, GenerationQuote, MediaItem, TopUpRequest } from './types'

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
  }
}

export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Не вдалося виконати запит. Спробуй ще раз.'

export const usd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

const money = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const invalidResponse = () => new Error('Сервер повернув неповні дані. Спробуй ще раз.')

const csrfCookie = () => document.cookie.split('; ').find((part) => part.startsWith('csrftoken='))?.slice(10)

async function request(path: string, method = 'GET', body?: object, signal?: AbortSignal) {
  const headers = new Headers({ Accept: 'application/json' })
  if (method !== 'GET') {
    if (!csrfCookie()) await request('/auth/csrf/')
    const token = csrfCookie()
    if (!token) throw new Error('Не вдалося підтвердити сеанс. Дозволь cookie для цього сайту.')
    headers.set('X-CSRFToken', token)
  }
  if (body && !(body instanceof FormData)) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch('/api' + path, {
      method, headers, credentials: 'same-origin', cache: 'no-store', signal,
      body: body instanceof FormData ? body : JSON.stringify(body),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new Error('Немає зв’язку із сервером. Перевір з’єднання й спробуй ще раз.')
  }
  if (response.status === 204) return null
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const fallback = response.status === 401 ? 'Увійди до акаунта.' : 'Сервіс тимчасово недоступний. Спробуй ще раз.'
    const detail = data?.detail ?? data?.error
    throw new ApiError(response.status, typeof detail === 'string' ? detail : fallback, data?.code)
  }
  if (data === null) throw invalidResponse()
  return data
}

function readAccount(data: unknown): Account {
  const value = data as Partial<Account> | null
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string'
    || typeof value.email !== 'string' || !money(value.balance_cents)) throw invalidResponse()
  return {
    id: value.id,
    name: value.name,
    email: value.email,
    balance_cents: value.balance_cents,
    total_spent_cents: money(value.total_spent_cents) ? value.total_spent_cents : null,
  }
}

export async function getAccount(): Promise<Account | null> {
  const data = await request('/account/')
  return data?.account === null ? null : readAccount(data?.account)
}

export async function authenticate(mode: 'login' | 'register', fields: Record<string, string>) {
  const data = await request('/auth/' + mode + '/', 'POST', fields)
  return readAccount(data?.account)
}

export async function saveProfile(fields: Record<string, string>) {
  const data = await request('/account/', 'PATCH', fields)
  return readAccount(data?.account)
}

export const logout = () => request('/auth/logout/', 'POST')
export async function getVideos(accountId: string, signal: AbortSignal): Promise<unknown[]> {
  const data = await request('/videos/', 'GET', undefined, signal)
  if (data?.account_id !== accountId) throw new ApiError(401, 'Сеанс акаунта змінився.')
  if (!Array.isArray(data?.results)) throw invalidResponse()
  return data.results
}
export const renameVideo = (id: string, title: string) =>
  request('/videos/' + encodeURIComponent(id) + '/', 'PATCH', { title })
export const deleteVideo = (id: string) => request('/videos/' + encodeURIComponent(id) + '/', 'DELETE')

export const submitTopUp = (account_id: string, amount_cents: number, request_id: string) =>
  request('/account/top-up-requests/', 'POST', { account_id, amount_cents, request_id })

export async function cancelTopUp(id: string): Promise<TopUpRequest> {
  const data = await request('/account/top-up-requests/' + encodeURIComponent(id) + '/cancel/', 'POST')
  if (!isTopUp(data) || data.id !== id || data.status !== 'canceled') throw invalidResponse()
  return data
}

function isTopUp(item: unknown): item is TopUpRequest {
  if (!item || typeof item !== 'object') return false
  const entry = item as TopUpRequest
  return typeof entry.id === 'string' && money(entry.amount_cents) && entry.amount_cents > 0
    && ['pending', 'approved', 'rejected', 'canceled'].includes(entry.status)
    && Number.isFinite(Date.parse(entry.created_at))
    && (entry.resolved_at === null || Number.isFinite(Date.parse(entry.resolved_at)))
}

export async function getTopUps(accountId: string, cursor: string | null, signal: AbortSignal) {
  const query = cursor === null ? '' : '?' + new URLSearchParams({ cursor })
  const data = await request('/account/top-up-requests/' + query, 'GET', undefined, signal)
  if (data?.account_id !== accountId) throw new ApiError(401, 'Сеанс акаунта змінився.')
  if (!Array.isArray(data.results) || !data.results.every(isTopUp)) throw invalidResponse()
  const next = data.next_cursor
  if (next !== null && (typeof next !== 'string' || !next || next === cursor)) throw invalidResponse()
  return { results: data.results as TopUpRequest[], next_cursor: next as string | null }
}

function isExpense(item: unknown): item is Expense {
  if (!item || typeof item !== 'object') return false
  const entry = item as Partial<Expense>
  return typeof entry.id === 'string' && entry.id.length > 0
    && typeof entry.created_at === 'string' && Number.isFinite(Date.parse(entry.created_at))
    && (entry.project_title === null || typeof entry.project_title === 'string')
    && money(entry.amount_cents) && entry.amount_cents > 0
}

export async function getExpenses(accountId: string, cursor: string | null, signal: AbortSignal): Promise<ExpensePage> {
  const query = cursor === null ? '' : '?' + new URLSearchParams({ cursor })
  const data = await request('/account/expenses/' + query, 'GET', undefined, signal)
  if (data?.account_id !== accountId) throw new ApiError(401, 'Сеанс акаунта змінився.')
  if (!Array.isArray(data?.results) || !data.results.every(isExpense)) throw invalidResponse()
  const next = data.next_cursor
  if (next !== null && (typeof next !== 'string' || !next || next === cursor)) throw invalidResponse()
  return { results: data.results, next_cursor: next }
}

export const changePassword = (current_password: string, new_password: string) =>
  request('/account/password/', 'POST', { current_password, new_password })
export const requestPasswordReset = (email: string) => request('/auth/password-reset/', 'POST', { email })
export const resetPassword = (uid: string, token: string, new_password: string) =>
  request('/auth/password-reset/confirm/', 'POST', { uid, token, new_password })

export async function getQuote(accountId: string, duration: number, aspect_ratio: string, signal: AbortSignal): Promise<GenerationQuote> {
  const data = await request('/generation/quote/', 'POST', { duration, aspect_ratio }, signal)
  if (data?.account_id !== accountId) throw new ApiError(401, 'Сеанс акаунта змінився.')
  if (typeof data?.quote_id !== 'string' || !data.quote_id || !money(data.price_cents)
    || !money(data.balance_cents) || !Number.isSafeInteger(data.duration) || data.duration <= 0) throw invalidResponse()
  return data as GenerationQuote
}

export async function generateVideo(draft: Draft, media: MediaItem[], quote: GenerationQuote) {
  const selected = draft.mediaIds.flatMap((id) => media.filter((item) => item.id === id))
  const photo = draft.useStartImage === false ? undefined : selected.find((item) => item.type === 'image')
  const form = new FormData()
  if (photo) {
    const url = new URL(photo.url || photo.image, window.location.href)
    if (url.origin === window.location.origin || url.protocol === 'blob:') {
      const response = await fetch(url)
      if (!response.ok) throw new Error('Не вдалося завантажити обране фото.')
      const blob = await response.blob()
      const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[blob.type]
      if (!extension || blob.size > 10 * 1024 * 1024) {
        throw new Error('Для генерації обери фото JPG, PNG або WebP розміром до 10 МБ.')
      }
      form.set('image', blob, 'image.' + extension)
    } else {
      form.set('image_url', url.href)
    }
  }
  const materials = selected.filter((item) => item.id !== photo?.id)
  if (materials.length > 12) throw new Error('Обери до 12 додаткових матеріалів.')
  const formats: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  }
  let bytes = 0
  for (const item of materials) {
    const response = await fetch(item.url || item.image)
    if (!response.ok) throw new Error('Не вдалося завантажити матеріал «' + item.name + '».')
    const blob = await response.blob()
    const extension = formats[blob.type]
    bytes += blob.size
    if (!extension || blob.size > 30 * 1024 * 1024 || bytes > 100 * 1024 * 1024) {
      throw new Error('Додаткові матеріали мають важити до 30 МБ кожен і до 100 МБ разом.')
    }
    form.append('materials', blob, 'material.' + extension)
  }
  const fields = {
    quote_id: quote.quote_id, topic: draft.topic, script: draft.script, format: draft.format,
    aspect_ratio: draft.format, duration: draft.duration, tone: draft.tone, voice: draft.voice,
    rate: draft.rate, music: draft.music, music_volume: draft.musicVolume,
    media_ids: JSON.stringify(draft.mediaIds), tags: JSON.stringify(draft.tags), subtitles: draft.subtitles,
  }
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
  const data = await request('/generate-video/', 'POST', form)
  if (data?.id !== quote.quote_id) throw invalidResponse()
  return data.id as string
}

export async function getVideoJob(id: string, signal: AbortSignal) {
  const data = await request('/generation/jobs/' + encodeURIComponent(id) + '/', 'GET', undefined, signal)
  if (data?.id !== id || !['queued', 'preparing', 'running', 'completed', 'failed'].includes(data.status)
    || !money(data.segments_done) || !money(data.segments_total)) throw invalidResponse()
  return {
    status: data.status as 'queued' | 'preparing' | 'running' | 'completed' | 'failed',
    done: data.segments_done, total: data.segments_total, project: data.project as unknown,
    detail: typeof data.detail === 'string' ? data.detail : 'Не вдалося завершити відео.',
  }
}
