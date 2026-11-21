import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clapperboard,
  Download,
  FileJson,
  FileText,
  FolderOpen,
  Image,
  Menu,
  Plus,
  Search,
  Settings2,
  Upload,
  UserRound,
  Wallet,
  X,
} from 'lucide-react'
import {
  Brand,
  Button,
  Dialog,
  EmptyState,
  Input,
  Notice,
  Preview,
  ProjectCard,
  Select,
} from './ui-kit'
import { defaultDraft, MAX_TOPIC_LENGTH, mediaLibrary } from './data'
import { MediaPage, SettingsPage } from './Pages'
import { createSubtitles, downloadFile, useStoredState } from './storage'
import Studio from './Studio'
import { AccountPage, AuthPage } from './AccountPages'
import { ApiError, deleteVideo, generateVideo, getVideoJob, getVideos, messageOf, renameVideo, usd } from './api'
import { useSession, type Session } from './useSession'
import type { Account, Draft, GenerationQuote, MediaItem, Project, Settings, View } from './types'

const guestSampleIds = new Set(['sample-mountains', 'sample-coast', 'sample-coffee'])

type Modal =
  | {
      type: 'new'
    }
  | {
      type: 'preview'
    }
  | {
      type: 'rename'
      project: Project
    }
  | {
      type: 'delete'
      project: Project
    }
  | {
      type: 'reset'
    }
  | {
      type: 'result'
      project: Project
    }

const viewDetails: Record<View, string> = {
  studio: 'Створити відео',
  projects: 'Мої проєкти',
  media: 'Медіатека',
  settings: 'Налаштування',
  account: 'Аккаунт',
  login: 'Вхід',
  register: 'Реєстрація',
  'forgot-password': 'Відновлення пароля',
  'reset-password': 'Зміна пароля',
}

const navItems = [
  {
    id: 'studio' as View,
    label: 'Створити відео',
    icon: Clapperboard,
  },
  {
    id: 'projects' as View,
    label: 'Мої проєкти',
    icon: FolderOpen,
  },
  {
    id: 'media' as View,
    label: 'Медіатека',
    icon: Image,
  },
]

function isDraft(item: unknown): item is Draft {
  if (!item || typeof item !== 'object') return false
  const value = item as Draft
  return (
    typeof value.topic === 'string' &&
    typeof value.script === 'string' &&
    ['9:16', '16:9', '1:1'].includes(value.format) &&
    Number.isSafeInteger(value.duration) && value.duration > 0 && value.duration <= 60 &&
    ['Натхненний', 'Інформативний', 'Розмовний'].includes(value.tone) &&
    Array.isArray(value.mediaIds) &&
    value.mediaIds.every((id) => typeof id === 'string') &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    typeof value.voice === 'string' &&
    typeof value.music === 'string' &&
    typeof value.subtitles === 'boolean' &&
    typeof value.rate === 'number' &&
    value.rate >= 0.7 &&
    value.rate <= 1.3 &&
    typeof value.musicVolume === 'number'
  )
}

function isProject(item: unknown): item is Project {
  if (!isDraft(item)) return false
  const value = item as Project
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    ['draft', 'ready'].includes(value.status) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isFinite(Date.parse(value.updatedAt))
  )
}

function isGeneratedProject(item: unknown): item is Project {
  return isProject(item) && item.status === 'ready'
    && /^[\da-f-]{36}$/i.test(item.id) && item.videoUrl === '/api/videos/' + item.id + '/file/'
}

function readDraft(key: string): Draft {
  try {
    const item = JSON.parse(localStorage.getItem(key) || 'null') as Partial<Draft> | null

    if (isDraft(item))
      return {
        ...defaultDraft,
        ...item,
        videoUrl: undefined,
      }

  } catch {
    return {
      ...defaultDraft,
    }
  }
  return {
    ...defaultDraft,
  }
}

function serializeDraft(draft: Draft) {
  return JSON.stringify({ ...defaultDraft, ...draft, videoUrl: undefined, posterUrl: undefined })
}

interface StudioResume {
  draft: Draft
  uploads: MediaItem[]
  step: number
}

export default function App() {
  const session = useSession()
  const resume = useRef<StudioResume | null>(null)
  const urls = useRef<string[]>([])
  const owner = session.account?.id
  useEffect(() => {
    const retained = new Set(resume.current?.uploads.map((item) => item.url))
    urls.current = urls.current.filter((url) => {
      if (retained.has(url)) return true
      URL.revokeObjectURL(url)
      return false
    })
    resume.current = null
  }, [owner])
  return <Workspace key={owner ? 'account/' + owner : 'guest'} session={session}
    resume={resume.current} objectUrls={urls} onSignIn={(account, studio) => {
      resume.current = studio
      session.replace(account)
    }} />
}

function Workspace({ session, resume, objectUrls, onSignIn }: {
  session: Session
  resume: StudioResume | null
  objectUrls: React.RefObject<string[]>
  onSignIn: (account: Account, studio: StudioResume | null) => void
}) {
  const { account } = session
  const refreshSession = session.refresh
  const prefix = account ? 'kadr-account:' + encodeURIComponent(account.id) + ':' : 'kadr-'
  const draftKey = prefix + 'draft'
  const [route, setRoute] = useState(() => location.hash.slice(1))
  const [page, query = ''] = route.split('?')
  const currentPage: View = Object.hasOwn(viewDetails, page) ? page as View : 'studio'
  const view = account && ['login', 'register', 'forgot-password'].includes(currentPage) ? 'account' : currentPage
  const returnToStudio = new URLSearchParams(query).get('next') === 'studio'
  const authView = view === 'login' || view === 'register' || view === 'forgot-password' || view === 'reset-password'
  const [settings, setSettings] = useStoredState<Settings>(
    prefix + 'settings',
    {
      autoSave: true,
      defaultDuration: 30,
      defaultFormat: '9:16',
    },
    (item) => {
      const value = item as Settings
      return (
        !!value &&
        typeof value.autoSave === 'boolean' &&
        [15, 30, 45, 60].includes(value.defaultDuration) &&
        ['9:16', '16:9', '1:1'].includes(value.defaultFormat)
      )
    }
  )
  const [localProjects, setProjects] = useStoredState<Project[]>(
    prefix + 'projects',
    [],
    (item) => Array.isArray(item) && item.every(isProject)
  )
  const [generatedProjects, setGeneratedProjects] = useState<Project[]>([])
  const [videoLoadError, setVideoLoadError] = useState('')
  const [videoRetry, setVideoRetry] = useState(0)
  const projects = [
    ...generatedProjects,
    ...localProjects.filter((project) => !project.videoUrl && (account || !guestSampleIds.has(project.id))),
  ]
  const [draft, setDraft] = useState<Draft>(() => resume?.draft ?? readDraft(draftKey))
  const [openedProjectId, setOpenedProjectId] = useState<string | null>(null)
  const previewProject = projects.find((project) => project.id === openedProjectId) ?? null
  const [step, setStep] = useState(resume?.step ?? 0)
  const [uploads, setUploads] = useState<MediaItem[]>(resume?.uploads ?? [])
  const [modal, setModal] = useState<Modal | null>(null)
  const [modalInput, setModalInput] = useState('')
  const [toast, setToast] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 800px)').matches)
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  const [projectQuery, setProjectQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState('all')
  const [projectSort, setProjectSort] = useState('recent')
  const toastTimer = useRef<number>(0)
  const generationLock = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const generationKey = prefix + 'generation-id'
  const submittedDraftKey = prefix + 'submitted-draft'
  const [generationId, setGenerationId] = useState<string | null>(() => account ? localStorage.getItem(generationKey) : null)
  const [generationProgress, setGenerationProgress] = useState('')
  const draftAtGeneration = useRef<Draft | null>(null)
  const generating = submitting || generationId !== null
  const refreshAllTabs = session.refreshAllTabs
  const mounted = useRef(true)
  const currentDraft = useRef(draft)
  currentDraft.current = draft
  const importRef = useRef<HTMLInputElement>(null)
  const allMedia = [...mediaLibrary, ...uploads]

  const resetEditor = useCallback(() => {
    localStorage.removeItem(draftKey)
    setDraft({ ...defaultDraft, duration: settings.defaultDuration, format: settings.defaultFormat })
    setStep(0)
    setOpenedProjectId(null)
  }, [draftKey, settings.defaultDuration, settings.defaultFormat])

  useEffect(() => {
    if (!generationId) return
    const controller = new AbortController()
    let timer = 0
    const finish = () => {
      localStorage.removeItem(generationKey)
      localStorage.removeItem(submittedDraftKey)
      draftAtGeneration.current = null
      setGenerationId(null)
      setGenerationProgress('')
      void refreshAllTabs()
    }
    const poll = async () => {
      try {
        const job = await getVideoJob(generationId, controller.signal)
        if (controller.signal.aborted) return
        if (job.status === 'failed') {
          finish()
          notify(job.detail)
          return
        }
        if (job.status === 'completed') {
          const submitted = localStorage.getItem(submittedDraftKey)
          const current = currentDraft.current
          const shouldReset = draftAtGeneration.current === current || submitted === serializeDraft(current)
          finish()
          const project = job.project
          if (!isGeneratedProject(project)) {
            notify('Сервер повернув неповні дані відео.')
            return
          }
          setGeneratedProjects((items) => [project, ...items.filter((item) => item.id !== project.id)])
          setVideoRetry((count) => count + 1)
          const legacyDraftMatches = submitted === null && current.topic.trim() === project.topic
            && current.script === project.script && current.duration === project.duration && current.format === project.format
          if (shouldReset || legacyDraftMatches) {
            resetEditor()
            if (location.hash.split('?')[0] === '#studio' || !location.hash) setModal({ type: 'result', project })
          }
          notify('Відео готове й збережене в проєктах.')
          return
        }
        setGenerationProgress(job.status === 'queued' ? 'Відео в черзі…' :
          job.status === 'preparing' ? 'Готуємо озвучку й матеріали…' :
          job.done === job.total ? 'Збираємо фінальний MP4…' : `Генеруємо частину ${job.done + 1} із ${job.total}…`)
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && [401, 404].includes(error.status)) {
          finish()
          notify(messageOf(error))
          return
        }
        setGenerationProgress('Відновлюємо зв’язок із сервером…')
      }
      timer = window.setTimeout(() => void poll(), 2000)
    }
    void poll()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [generationId, generationKey, submittedDraftKey, refreshAllTabs, resetEditor])

  useEffect(() => {
    if (!account?.id || session.status !== 'ready') return
    const controller = new AbortController()
    setVideoLoadError('')
    void getVideos(account.id, controller.signal).then((items) => {
      if (controller.signal.aborted) return
      if (!items.every(isGeneratedProject)) throw new Error('Не вдалося прочитати список відео.')
      setGeneratedProjects(items)
    }).catch((error) => {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.status === 401) {
        setGeneratedProjects([])
        void refreshSession()
      } else setVideoLoadError(messageOf(error))
    })
    return () => controller.abort()
  }, [account?.id, session.status, videoRetry, view, refreshSession])

  useEffect(() => {
    if (draft.id && draft.id !== openedProjectId && generatedProjects.some((project) => project.id === draft.id)) {
      resetEditor()
    }
  }, [draft.id, openedProjectId, generatedProjects, resetEditor])

  useEffect(() => {
    if (settings.autoSave) {
      try {
        localStorage.setItem(draftKey, serializeDraft(draft))
      } catch {
        return
      }
    }
  }, [draft, draftKey, settings.autoSave])

  useEffect(() => {
    const handleHash = () => {
      setRoute(location.hash.slice(1))
      setSidebarOpen(false)
    }
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 800px)')
    const resize = () => {
      setIsMobile(mediaQuery.matches)
      setSidebarOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false)
    }
    mediaQuery.addEventListener('change', resize)
    document.addEventListener('keydown', escape)
    return () => {
      mediaQuery.removeEventListener('change', resize)
      document.removeEventListener('keydown', escape)
    }
  }, [])

  useEffect(() => {
    document.title = `${viewDetails[view]} - Кадр`
    setProjectMenu(null)
  }, [view])

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!(event.target as Element).closest('.project-menu-wrap')) setProjectMenu(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(toastTimer.current)
    }
  }, [])

  const notify = (message: string) => {
    window.clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = window.setTimeout(() => setToast(''), 5000)
  }

  const navigate = (target: View, continueStudio = false) => {
    const keepDraft = continueStudio || (returnToStudio && ['login', 'register', 'forgot-password'].includes(target))
    const next = target + (keepDraft ? '?next=studio' : '')
    setRoute(next)
    location.hash = next
    setSidebarOpen(false)
    window.scrollTo({
      top: 0,
      behavior: 'instant',
    })
  }

  const updateDraft = (patch: Partial<Draft>) =>
    setDraft((current) => ({
      ...current,
      ...patch,
    }))

  const saveProject = (status: 'draft' | 'ready' = 'draft', silent = false) => {
    if (draft.topic.trim().length < 5) {
      if (!silent) notify('Додай тему відео перед збереженням.')
      return
    }
    const now = new Date().toISOString()
    const id = draft.id && !draft.videoUrl && !generatedProjects.some((item) => item.id === draft.id)
      ? draft.id : crypto.randomUUID()
    const existing = projects.find((project) => project.id === id)
    const project: Project = {
      ...draft,
      videoUrl: undefined,
      id,
      title: existing?.title || draft.topic.trim().slice(0, 70),
      status,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    setProjects((current) => [project, ...current.filter((item) => item.id !== id)])
    updateDraft({
      id,
      videoUrl: undefined,
    })
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({
          ...draft,
          videoUrl: undefined,
          id,
        })
      )
    } catch {
      notify('У браузері недостатньо місця для збереження.')
      return
    }
    if (!silent)
      notify(status === 'ready' ? 'Проєкт збережено.' : 'Чернетку збережено в цьому браузері.')
  }

  const startNew = () => {
    setModalInput('')
    setModal({
      type: 'new',
    })
  }

  const createNew = () => {
    if (draft.topic.trim().length >= 5) saveProject('draft', true)
    setDraft({
      ...defaultDraft,
      topic: modalInput.trim(),
      duration: settings.defaultDuration,
      format: settings.defaultFormat,
    })
    setOpenedProjectId(null)
    setStep(0)
    setModal(null)
    navigate('studio')
    notify('Проєкт створено.')
  }

  const editProject = (project: Project) => {
    const availableIds = project.mediaIds.filter((id) => allMedia.some((item) => item.id === id))
    if (availableIds.length !== project.mediaIds.length)
      notify('Додай власні файли повторно: вони не зберігаються між сеансами.')
    setDraft({
      ...project,
      mediaIds: availableIds,
    })
    setOpenedProjectId(project.id)
    setStep(0)
    navigate('studio')
  }

  const exportProject = (project: Draft | Project) => {
    const {
      id,
      topic,
      format,
      duration,
      tone,
      script,
      tags,
      voice,
      rate,
      music,
      musicVolume,
      subtitles,
      mediaIds,
    } = project
    const config = {
      version: 1,
      mode: 'frontend',
      language: 'uk',
      id,
      title: 'title' in project ? project.title : topic,
      topic,
      format,
      duration,
      tone,
      script,
      search_terms: tags,
      voice: {
        name: voice,
        provider: 'edge-tts',
        rate,
      },
      music: {
        name: music,
        volume: musicVolume,
      },
      subtitles,
      media: mediaIds.map((mediaId) => {
        const item = allMedia.find((entry) => entry.id === mediaId)
        return {
          id: mediaId,
          name: item?.name || 'Власний матеріал',
          type: item?.type || 'unknown',
          requires_upload: !!item?.local || !item,
        }
      }),
      output: {
        resolution:
          format === '9:16' ? [1080, 1920] : format === '16:9' ? [1920, 1080] : [1080, 1080],
        fps: 24,
        format: 'mp4',
      },
    }
    downloadFile(
      JSON.stringify(config, null, 2),
      `kadr-${id || 'project'}.json`,
      'application/json'
    )
    notify('Налаштування проєкту завантажено у JSON.')
  }

  const importProjects = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      notify('JSON-файл має бути меншим за 10 МБ.')
      return
    }
    try {
      const data = JSON.parse(await file.text())
      const now = new Date().toISOString()
      let imported: Project[] = []
      if (
        data &&
        Array.isArray(data.projects) &&
        data.projects.length <= 100 &&
        data.projects.every(isProject)
      ) {
        imported = data.projects.map((project: Project) => ({
          ...project,
          videoUrl: undefined,
          status: 'draft',
          id: crypto.randomUUID(),
          title: project.title.slice(0, 70),
          updatedAt: now,
        }))
      } else if (
        data?.version === 1 &&
        typeof data.topic === 'string' &&
        typeof data.script === 'string' &&
        Array.isArray(data.media) &&
        Array.isArray(data.search_terms)
      ) {
        const candidate = {
          ...defaultDraft,
          topic: data.topic.slice(0, MAX_TOPIC_LENGTH),
          script: data.script.slice(0, 3000),
          format: data.format,
          duration: data.duration,
          tone: data.tone,
          tags: data.search_terms.slice(0, 10),
          mediaIds: data.media.slice(0, 100).map((item: { id: string }) => item.id),
          voice: data.voice?.name,
          rate: data.voice?.rate,
          music: data.music?.name,
          musicVolume: data.music?.volume,
          subtitles: data.subtitles,
        }
        if (!isDraft(candidate)) throw new Error('Invalid project')
        imported = [
          {
            ...candidate,
            id: crypto.randomUUID(),
            title: (typeof data.title === 'string' ? data.title : candidate.topic).slice(0, 70),
            status: 'draft',
            createdAt: now,
            updatedAt: now,
          },
        ]
      } else throw new Error('Unsupported file')
      setProjects((current) => [...imported, ...current])
      notify(`Імпортовано проєктів: ${imported.length}. Власні медіафайли потрібно додати окремо.`)
    } catch {
      notify('Не вдалося прочитати файл. Обери JSON-проєкт або резервну копію Кадру.')
    }
  }


 
  const handleGenerateVideo = async (quote: GenerationQuote) => {
    if (generationLock.current || generating || !account || session.status !== 'ready' || account.balance_cents < quote.price_cents) {
      throw new Error('Перевір баланс і ціну перед генерацією.')
    }
    generationLock.current = true
    setSubmitting(true)
    try {
      const jobId = await generateVideo(draft, allMedia, quote)
      localStorage.setItem(submittedDraftKey, serializeDraft(draft))
      localStorage.setItem(generationKey, jobId)
      if (!mounted.current) return
      draftAtGeneration.current = draft
      setGenerationId(jobId)
      setGenerationProgress('Відео в черзі…')
    } finally {
      generationLock.current = false
      if (mounted.current) {
        setSubmitting(false)
        await session.refreshAllTabs()
      }
    }
  }

  const projectAction = (
    project: Project,
    action: 'edit' | 'rename' | 'duplicate' | 'export' | 'delete'
  ) => {
    setProjectMenu(null)
    if (action === 'edit') return editProject(project)
    if (action === 'rename') {
      setModalInput(project.title)
      setModal({
        type: 'rename',
        project,
      })
    }
    if (action === 'delete')
      setModal({
        type: 'delete',
        project,
      })
    if (action === 'export') exportProject(project)
    if (action === 'duplicate') {
      const now = new Date().toISOString()
      setProjects((current) => [
        {
          ...project,
          videoUrl: undefined,
          id: crypto.randomUUID(),
          title: `${project.title} - копія`,
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        },
        ...current,
      ])
      notify('Копію додано до твоїх проєктів.')
    }
  }

  const uploadFiles = (files: FileList | null) => {
    if (!files?.length) return
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'audio/wav',
      'audio/x-wav',
    ]
    const added: MediaItem[] = []
    let rejected = 0
    for (const file of Array.from(files)) {
      if (!allowed.includes(file.type) || file.size > 50 * 1024 * 1024 || file.size === 0) {
        rejected++
        continue
      }
      const url = URL.createObjectURL(file)
      objectUrls.current.push(url)
      const type = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/')
          ? 'video'
          : 'audio'
      added.push({
        id: crypto.randomUUID(),
        name: file.name,
        image: type === 'image' ? url : '',
        url,
        type,
        category: 'Власні матеріали',
        tags: [file.name.toLowerCase()],
        local: true,
      })
    }
    setUploads((current) => [...current, ...added])
    if (added.length)
      updateDraft({
        mediaIds: [
          ...draft.mediaIds,
          ...added.map((item) => item.id),
        ],
      })
    notify(
      `${added.length ? `Додано матеріалів: ${added.length}.` : ''}${rejected ? ' Деякі файли не підтримуються, порожні або більші за 50 МБ.' : ''}`.trim()
    )
  }

  const removeUpload = (id: string) => {
    const item = uploads.find((entry) => entry.id === id)
    if (item?.url) {
      URL.revokeObjectURL(item.url)
      objectUrls.current = objectUrls.current.filter((url) => url !== item.url)
    }
    setUploads((current) => current.filter((entry) => entry.id !== id))
    updateDraft({
      mediaIds: draft.mediaIds.filter((value) => value !== id),
    })
    notify('Матеріал видалено з поточного сеансу.')
  }

  const sortedProjects = [...projects]
    .filter(
      (project) =>
        (projectFilter === 'all' || project.status === projectFilter) &&
        `${project.title} ${project.topic}`.toLowerCase().includes(projectQuery.toLowerCase())
    )
    .sort((a, b) =>
      projectSort === 'name'
        ? a.title.localeCompare(b.title, 'uk')
        : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )

  const projectCards = (items: Project[]) =>
    items.map((project) => (
      <ProjectCard
        key={project.id}
        project={project}
        media={allMedia}
        onOpen={() => {
          setOpenedProjectId(project.id)
          setProjectMenu(null)
          setModal({ type: 'preview' })
        }}
        onMenu={() => setProjectMenu((current) => (current === project.id ? null : project.id))}
        menuOpen={projectMenu === project.id}
        onAction={(action) => projectAction(project, action)}
      />
    ))

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <Button
          className="sidebar-scrim"
          aria-label="Закрити навігацію"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        id="studio-navigation"
        inert={isMobile && !sidebarOpen}
        className={`sidebar ${sidebarOpen ? 'open' : ''}`}
      >
        <Button
          className="brand-link"
          aria-label="Кадр - головна"
          onClick={() => navigate('studio')}
        >
          <Brand />
        </Button>
        <nav className="main-nav" aria-label="Головна навігація">
          {navItems.map((item) => (
            <Button
              key={item.id}
              className={view === item.id ? 'active' : ''}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} strokeWidth={1.6} />
              <span>{item.label}</span>
              {item.id === 'projects' && <span className="nav-count">{projects.length}</span>}
            </Button>
          ))}
        </nav>
        <nav className="secondary-nav" aria-label="Налаштування">
          <Button className={view === 'account' || authView ? 'active' : ''}
            onClick={() => navigate('account')}>
            <UserRound size={18} strokeWidth={1.6} /> Аккаунт
          </Button>
          <Button
            className={view === 'settings' ? 'active' : ''}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={18} strokeWidth={1.6} /> Налаштування
          </Button>
        </nav>
      </aside>
      <div className="main-shell">
        <header className="account-topbar">
          <Button
            className="icon-button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Відкрити навігацію"
            aria-expanded={sidebarOpen}
            aria-controls="studio-navigation"
          >
            <Menu size={22} />
          </Button>
          <span className="mobile-brand">Кадр</span>
          <div className="topbar-account">
            <Button className="balance-chip" onClick={() => navigate('account')}
              aria-label={account && session.status === 'ready' ? 'Баланс акаунта ' + usd(account.balance_cents) : 'Баланс акаунта недоступний'}
              title={account && session.status === 'ready' ? 'Баланс акаунта' : 'Баланс доступний після входу та з’єднання із сервером'}>
              <Wallet size={16} /><span>Баланс</span>
              <strong>{account && session.status === 'ready' ? usd(account.balance_cents) : '—'}</strong>
            </Button>
            <Button className="identity-button" onClick={() => navigate(account ? 'account' : 'login')}>
              <UserRound size={16} /><span>{account ? account.name : 'Увійти'}</span>
            </Button>
          </div>
        </header>
        <main>
          {view !== 'studio' && !authView && (view !== 'account' || account) && (
            <div className="page-heading">
              <h1>{viewDetails[view]}</h1>
              {view === 'projects' && (
                <Button className="new-project-button" onClick={startNew}>
                  <Plus size={17} /> Новий проєкт
                </Button>
              )}
            </div>
          )}
          {(authView || (view === 'account' && !account)) && (
            <AuthPage key={route} mode={authView ? view : 'login'} resetQuery={query} onNavigate={navigate}
              onAuthenticated={(signedIn) => {
                const studio = returnToStudio ? { draft: { ...draft, id: null }, uploads, step } : null
                navigate(studio ? 'studio' : 'account')
                onSignIn(signedIn, studio)
              }} />
          )}
          {view === 'account' && account && (
            <AccountPage account={account} session={session} onLogout={() => {
              navigate('login')
              session.replace(null)
            }} />
          )}
          {view === 'studio' && (
            <Studio
              draft={draft}
              previewProject={previewProject}
              updateDraft={updateDraft}
              step={step}
              onStep={setStep}
              media={allMedia}
              onUpload={uploadFiles}
              onSave={() => saveProject()}
              session={session}
              generating={generating}
              generationProgress={generationProgress}
              onRegister={() => navigate('register', true)}
              onGenerate={handleGenerateVideo}
              onExpand={() =>
                setModal({
                  type: 'preview',
                })
              }
              onToast={notify}
            />
          )}
          {view === 'projects' && (
            <>
              <div className="list-toolbar">
                <div className="filter-tabs">
                  {[
                    ['all', 'Усі'],
                    ['ready', 'Збережені'],
                    ['draft', 'Чернетки'],
                  ].map(([id, name]) => (
                    <Button
                      key={id}
                      className={projectFilter === id ? 'active' : ''}
                      onClick={() => setProjectFilter(id)}
                    >
                      {name}
                      <span>
                        {projects.filter((item) => id === 'all' || item.status === id).length}
                      </span>
                    </Button>
                  ))}
                </div>
                <div className="project-list-controls">
                  <div className="search-field">
                    <Search size={16} />
                    <Input
                      aria-label="Пошук проєктів"
                      value={projectQuery}
                      onChange={(event) => setProjectQuery(event.target.value)}
                      placeholder="Знайти проєкт"
                    />
                    {projectQuery && (
                      <Button
                        className="icon-button"
                        aria-label="Очистити пошук проєктів"
                        onClick={() => setProjectQuery('')}
                      >
                        <X size={14} />
                      </Button>
                    )}
                  </div>
                  <div className="select-wrap sort-select">
                    <Select
                      aria-label="Сортування проєктів"
                      value={projectSort}
                      onChange={(event) => setProjectSort(event.target.value)}
                    >
                      <option value="recent">Спочатку нові</option>
                      <option value="name">За назвою</option>
                    </Select>
                    <ChevronDown size={14} />
                  </div>
                  <Button
                    className="icon-button import-button"
                    aria-label="Імпортувати проєкти з JSON"
                    title="Імпортувати JSON"
                    onClick={() => importRef.current?.click()}
                  >
                    <Upload size={17} />
                  </Button>
                  <Input
                    ref={importRef}
                    hidden
                    type="file"
                    accept=".json,application/json"
                    onChange={(event) => {
                      void importProjects(event.target.files?.[0])
                      event.target.value = ''
                    }}
                  />
                </div>
              </div>
              {videoLoadError && (
                <p role="alert">{videoLoadError}{' '}
                  <Button className="form-link" onClick={() => setVideoRetry((count) => count + 1)}>Оновити відео</Button>
                </p>
              )}
              <div className="project-grid all-projects">{projectCards(sortedProjects)}</div>
              {!sortedProjects.length && (
                <EmptyState>
                  <FolderOpen size={38} />
                  <h3>{projectQuery ? 'Проєктів не знайдено' : 'Проєктів ще немає'}</h3>
                  <Button
                    className="primary-button"
                    onClick={
                      projectQuery
                        ? () => {
                            setProjectQuery('')
                            setProjectFilter('all')
                          }
                        : startNew
                    }
                  >
                    {projectQuery ? 'Скинути пошук' : 'Створити проєкт'}
                    <ArrowRight size={15} />
                  </Button>
                </EmptyState>
              )}
            </>
          )}
          {view === 'media' && (
            <MediaPage
              media={allMedia}
              selectedIds={draft.mediaIds}
              onToggle={(id) =>
                updateDraft({
                  mediaIds: draft.mediaIds.includes(id)
                    ? draft.mediaIds.filter((item) => item !== id)
                    : [...draft.mediaIds, id],
                })
              }
              onUpload={uploadFiles}
              onRemove={removeUpload}
              onStudio={() => {
                setStep(3)
                navigate('studio')
              }}
            />
          )}
          {view === 'settings' && (
            <SettingsPage
              settings={settings}
              projects={projects}
              onSave={setSettings}
              onToast={notify}
              onReset={() =>
                setModal({
                  type: 'reset',
                })
              }
            />
          )}
        </main>
      </div>
      {toast && (
        <Notice className="toast" role="status">
          <span className="toast-check">
            <Check size={15} />
          </span>
          <p>{toast}</p>
          <Button
            className="icon-button"
            aria-label="Закрити повідомлення"
            onClick={() => setToast('')}
          >
            <X size={15} />
          </Button>
        </Notice>
      )}
      {modal?.type === 'new' && (
        <Dialog title="Новий проєкт" onClose={() => setModal(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              createNew()
            }}
          >
            <label className="field-label" htmlFor="new-topic">
              Тема відео <span className="optional">необов’язково</span>
            </label>
            <Input
              className="full-input"
              id="new-topic"
              maxLength={500}
              value={modalInput}
              onChange={(event) => setModalInput(event.target.value)}
              placeholder="Введи тему"
              autoFocus
            />
            <div className="dialog-actions">
              <Button className="secondary-button" type="button" onClick={() => setModal(null)}>
                Скасувати
              </Button>
              <Button className="primary-button" type="submit">
                Створити проєкт
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {modal?.type === 'preview' && previewProject && (
        <Dialog title="Попередній перегляд" onClose={() => setModal(null)} wide>
          <Preview key={previewProject.id} draft={previewProject} media={allMedia} expanded />
        </Dialog>
      )}
      {modal?.type === 'rename' && (
        <Dialog title="Перейменувати проєкт" onClose={() => setModal(null)}>
          <form
            onSubmit={async (event) => {
              event.preventDefault()
              if (!modalInput.trim()) return
              if (isGeneratedProject(modal.project)) {
                try {
                  const updated = await renameVideo(modal.project.id, modalInput.trim())
                  if (!isGeneratedProject(updated)) throw new Error('Не вдалося прочитати зміни.')
                  setGeneratedProjects((items) => items.map((item) => item.id === updated.id ? updated : item))
                  setVideoRetry((count) => count + 1)
                } catch (error) {
                  notify(messageOf(error))
                  return
                }
              } else setProjects((current) =>
                current.map((project) =>
                  project.id === modal.project.id
                    ? {
                        ...project,
                        title: modalInput.trim(),
                        updatedAt: new Date().toISOString(),
                      }
                    : project
                )
              )
              setModal(null)
              notify('Назву проєкту оновлено.')
            }}
          >
            <label className="field-label" htmlFor="project-title">
              Назва проєкту
            </label>
            <Input
              className="full-input"
              id="project-title"
              maxLength={70}
              required
              value={modalInput}
              onChange={(event) => setModalInput(event.target.value)}
              autoFocus
            />
            <div className="dialog-actions">
              <Button className="secondary-button" type="button" onClick={() => setModal(null)}>
                Скасувати
              </Button>
              <Button className="primary-button" type="submit" disabled={!modalInput.trim()}>
                Зберегти назву
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {modal?.type === 'delete' && (
        <Dialog title="Видалити проєкт?" onClose={() => setModal(null)}>
          <p className="dialog-copy">
            Проєкт «{modal.project.title}» буде видалено {isGeneratedProject(modal.project) ? 'з акаунта' : 'з цього браузера'}.
          </p>
          <div className="dialog-actions">
            <Button className="secondary-button" onClick={() => setModal(null)}>
              Скасувати
            </Button>
            <Button
              className="danger-button"
              onClick={async () => {
                if (isGeneratedProject(modal.project)) {
                  try {
                    await deleteVideo(modal.project.id)
                    setGeneratedProjects((items) => items.filter((item) => item.id !== modal.project.id))
                    setVideoRetry((count) => count + 1)
                  } catch (error) {
                    notify(messageOf(error))
                    return
                  }
                } else setProjects((current) => current.filter((item) => item.id !== modal.project.id))
                if (draft.id === modal.project.id)
                  setDraft({
                    ...defaultDraft,
                  })
                setModal(null)
                notify('Проєкт видалено.')
              }}
            >
              Видалити
            </Button>
          </div>
        </Dialog>
      )}
      {modal?.type === 'reset' && (
        <Dialog title="Очистити дані?" onClose={() => setModal(null)}>
          <p className="dialog-copy">
            Проєкти, чернетки й налаштування буде видалено з цього браузера. Перед очищенням збережи
            резервну копію.
          </p>
          <div className="dialog-actions">
            <Button className="secondary-button" onClick={() => setModal(null)}>
              Скасувати
            </Button>
            <Button
              className="danger-button"
              onClick={() => {
                setProjects([])
                setOpenedProjectId(null)
                setDraft({
                  ...defaultDraft,
                })
                setSettings({
                  autoSave: true,
                  defaultDuration: 30,
                  defaultFormat: '9:16',
                })
                objectUrls.current.forEach((url) => URL.revokeObjectURL(url))
                objectUrls.current = []
                setUploads([])
                localStorage.removeItem(draftKey)
                setModal(null)
                notify('Дані очищено.')
              }}
            >
              Очистити дані
            </Button>
          </div>
        </Dialog>
      )}
      {modal?.type === 'result' && (
        <Dialog title="Проєкт збережено" onClose={() => setModal(null)}>
          <div className="result-summary">
            <strong>{modal.project.topic}</strong>
            <span>
              {modal.project.format} · {modal.project.duration} с · {modal.project.mediaIds.length} матеріали
            </span>
          </div>
          <div className="export-options">
            <Button onClick={() => exportProject(modal.project)}>
              <FileJson size={20} />
              <div>
                <strong>Проєкт</strong>
                <span>JSON</span>
              </div>
              <Download size={16} />
            </Button>
            <Button
              onClick={() => {
                downloadFile(
                  createSubtitles(modal.project.script, modal.project.duration),
                  'kadr-subtitles.srt',
                  'text/plain;charset=utf-8'
                )
                notify('Субтитри завантажено. Час розподілено рівномірно.')
              }}
            >
              <FileText size={20} />
              <div>
                <strong>Субтитри</strong>
                <span>SRT</span>
              </div>
              <Download size={16} />
            </Button>
          </div>
          <div className="dialog-actions">
            <Button className="secondary-button" onClick={() => setModal(null)}>
              До редактора
            </Button>
            <Button
              className="primary-button"
              onClick={() => {
                setModal(null)
                navigate('projects')
              }}
            >
              Мої проєкти <ArrowRight size={15} />
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
