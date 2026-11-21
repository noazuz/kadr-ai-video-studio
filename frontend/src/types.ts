export type AuthView = 'login' | 'register' | 'forgot-password' | 'reset-password'
export type View = 'studio' | 'projects' | 'media' | 'settings' | 'account' | AuthView

export interface Account {
  id: string
  name: string
  email: string
  balance_cents: number
  total_spent_cents?: number | null
}

export interface Expense {
  id: string
  created_at: string
  project_title: string | null
  amount_cents: number
}

export interface ExpensePage {
  results: Expense[]
  next_cursor: string | null
}

export interface TopUpRequest {
  id: string
  amount_cents: number
  status: 'pending' | 'approved' | 'rejected' | 'canceled'
  created_at: string
  resolved_at: string | null
}

export interface GenerationQuote {
  quote_id: string
  price_cents: number
  balance_cents: number
  duration: number
}
export type VideoFormat = '9:16' | '16:9' | '1:1'
export type ProjectStatus = 'draft' | 'ready'
export type Tone = 'Натхненний' | 'Інформативний' | 'Розмовний'

export interface Draft {
  id: string | null
  topic: string
  format: VideoFormat
  duration: number
  tone: Tone
  script: string
  tags: string[]
  voice: string
  rate: number
  music: string
  musicVolume: number
  subtitles: boolean
  mediaIds: string[]
  useStartImage?: boolean
  audioUrl?: string
  videoUrl?: string
  posterUrl?: string
}

export interface Project extends Draft {
  id: string
  title: string
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

export interface MediaItem {
  id: string
  name: string
  image: string
  type: 'image' | 'video' | 'audio'
  category: string
  tags: string[]
  duration?: number
  local?: boolean
  url?: string
}

export interface Settings {
  autoSave: boolean
  defaultDuration: number
  defaultFormat: VideoFormat
}
