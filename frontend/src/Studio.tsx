import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Copy,
  FileText,
  Film,
  Maximize2,
  Mic2,
  Music2,
  Play,
  Search,
  Upload,
} from 'lucide-react'
import {
  Button,
  Field,
  FormatChoice,
  Input,
  MediaCard,
  Preview,
  Select,
  StepNavigation,
  Textarea,
  Toggle,
} from './ui-kit'
import { createScriptTemplate, MAX_TOPIC_LENGTH, steps } from './data'
import GenerationCheckout from './GenerationCheckout'
import type { Session } from './useSession'
import type { Draft, GenerationQuote, MediaItem, Project, Tone } from './types'

interface StudioProps {
  draft: Draft
  previewProject: Project | null
  updateDraft: (patch: Partial<Draft>) => void
  step: number
  onStep: (step: number) => void
  media: MediaItem[]
  onUpload: (files: FileList | null) => void
  onSave: () => void
  session: Session
  generating: boolean
  generationProgress: string
  onRegister: () => void
  onGenerate: (quote: GenerationQuote) => Promise<void>
  onExpand: () => void
  onToast: (message: string) => void
}

export default function Studio({
  draft,
  previewProject,
  updateDraft,
  step,
  onStep,
  media,
  onUpload,
  onSave,
  session,
  generating,
  generationProgress,
  onRegister,
  onGenerate,
  onExpand,
  onToast,
}: StudioProps) {
  const [mediaQuery, setMediaQuery] = useState('')
  const [mediaSource, setMediaSource] = useState('library')
  const [tagInput, setTagInput] = useState('')
  const [voicePlaying, setVoicePlaying] = useState(false)
  const [voiceLoading, setVoiceLoading] = useState(false)
  const voiceAttempt = useRef(0)
  const voiceAudio = useRef<HTMLAudioElement>(null)
  const voiceSample = draft.voice === 'Поліна' ? 'polina.mp3' : 'ostap.mp3'
  const [topicError, setTopicError] = useState(false)

  const uploadRef = useRef<HTMLInputElement>(null)
  const topicRef = useRef<HTMLTextAreaElement>(null)

  const validateTopic = () => {
    if (draft.topic.trim().length < 5) {
      setTopicError(true)
      onStep(0)
      window.setTimeout(() => topicRef.current?.focus(), 50)
      onToast('Опиши тему хоча б п’ятьма символами.')
      return false
    }
    setTopicError(false)
    return true
  }

  const generateScript = () => {
    if (!validateTopic()) return
    const result = createScriptTemplate(draft.topic, draft.tone, draft.duration)
    updateDraft(result)
    onToast('Шаблон сценарію створено.')
  }

  const nextStep = () => {
    if (!validateTopic()) return
    if (step === 0 && !draft.script.trim())
      updateDraft(createScriptTemplate(draft.topic, draft.tone, draft.duration))
    if (step === 1 && !draft.script.trim()) {
      onToast('Додай текст сценарію, щоб перейти до озвучки.')
      return
    }
    onStep(step + 1)
  }

  const selectStep = (target: number) => {
    if (target > 0 && !validateTopic()) return
    if (target > 1 && !draft.script.trim()) {
      onToast('Спочатку додай сценарій.')
      onStep(1)
      return
    }
    onStep(target)
  }

  const toggleMedia = (id: string) =>
    updateDraft({
      mediaIds: draft.mediaIds.includes(id)
        ? draft.mediaIds.filter((item) => item !== id)
        : [...draft.mediaIds, id],
    })

  useEffect(() => {
    const audio = voiceAudio.current
    setVoicePlaying(false)
    setVoiceLoading(false)
    return () => {
      voiceAttempt.current++
      audio?.pause()
    }
  }, [step, voiceSample])

  useEffect(() => {
    if (voiceAudio.current) voiceAudio.current.playbackRate = draft.rate
  }, [step, voiceSample, draft.rate])

  const previewVoice = async () => {
    const audio = voiceAudio.current
    if (!audio) return
    if (!audio.paused) {
      audio.pause()
      audio.currentTime = 0
      setVoicePlaying(false)
      return
    }
    const attempt = ++voiceAttempt.current
    audio.playbackRate = draft.rate
    setVoiceLoading(true)
    try {
      await audio.play()
      if (attempt === voiceAttempt.current) setVoicePlaying(!audio.paused)
    } catch {
      if (attempt === voiceAttempt.current) onToast('Не вдалося відтворити зразок голосу.')
    } finally {
      if (attempt === voiceAttempt.current) setVoiceLoading(false)
    }
  }

  const visibleMedia = media.filter(
    (item) =>
      (mediaSource === 'own' ? item.local : !item.local) &&
      `${item.name} ${item.tags.join(' ')}`.toLowerCase().includes(mediaQuery.toLowerCase())
  )

  const wordCount = draft.script.trim().split(/\s+/).filter(Boolean).length
  const narrationSeconds = wordCount / (2.2 * draft.rate)
  const scriptTooLong = narrationSeconds > draft.duration * 1.4

  return (
    <>
      <div className="studio-grid">
        <section className="editor-card" aria-label="Редактор відеопроєкту">
          <div className="editor-heading">
            <div className="editor-label">
              <span className="orange-icon">
                <Film size={17} />
              </span>
              <h1>Створити відео</h1>
            </div>
            <span className="editor-step-count">Крок {step + 1} з 4</span>
          </div>
          <StepNavigation
            labels={steps.map((item) => item.title)}
            current={step}
            onChange={selectStep}
          />
          <div className="editor-content">
            {step === 0 && (
              <div className="step-content">
                <Field
                  label="Тема відео"
                  id="topic"
                  required
                  error={topicError ? 'Введи щонайменше 5 символів.' : undefined}
                >
                  <div className={`topic-field ${topicError ? 'invalid' : ''}`}>
                    <Textarea
                      id="topic"
                      ref={topicRef}
                      maxLength={MAX_TOPIC_LENGTH}
                      value={draft.topic}
                      onChange={(event) => {
                        updateDraft({
                          topic: event.target.value,
                          script: '',
                        })
                        setTopicError(false)
                      }}
                      placeholder="Наприклад, подорож у Карпати"
                    />
                    <span className="field-count">{draft.topic.length} / {MAX_TOPIC_LENGTH}</span>
                  </div>
                </Field>
                <div className="field-divider" />
                <FormatChoice
                  value={draft.format}
                  onChange={(format) =>
                    updateDraft({
                      format,
                    })
                  }
                />
                <div className="field-row">
                  <div className="field">
                    <label className="field-label" htmlFor="duration">
                      Тривалість
                    </label>
                    <div className="select-wrap">
                      <Select
                        id="duration"
                        value={draft.duration}
                        onChange={(event) =>
                          updateDraft({
                            duration: Number(event.target.value),
                            script: '',
                          })
                        }
                      >
                        {Array.from({ length: 60 }, (_, index) => index + 1).map((duration) => (
                          <option key={duration} value={duration}>
                            {duration} с
                          </option>
                        ))}
                      </Select>
                      <ChevronDown size={15} />
                    </div>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="tone">
                      Стиль сценарію
                    </label>
                    <div className="select-wrap">
                      <Select
                        id="tone"
                        value={draft.tone}
                        onChange={(event) =>
                          updateDraft({
                            tone: event.target.value as Tone,
                            script: '',
                          })
                        }
                      >
                        {['Натхненний', 'Інформативний', 'Розмовний'].map((tone) => (
                          <option key={tone}>{tone}</option>
                        ))}
                      </Select>
                      <ChevronDown size={15} />
                    </div>
                  </div>
                </div>
              </div>
            )}
            {step === 1 && (
              <div className="step-content">
                <div className="section-title with-action">
                  <div>
                    <h3>Сценарій</h3>
                  </div>
                </div>
                <div className="script-meta">
                  <span>
                    <FileText size={13} /> Текст сценарію
                  </span>
                  <Button
                    className="text-button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(draft.script)
                        onToast('Сценарій скопійовано.')
                      } catch {
                        onToast('Не вдалося скопіювати.')
                      }
                    }}
                  >
                    <Copy size={13} /> Копіювати
                  </Button>
                </div>
                <Textarea
                  className="script-editor"
                  aria-label="Текст сценарію"
                  maxLength={3000}
                  value={draft.script}
                  onChange={(event) =>
                    updateDraft({
                      script: event.target.value,
                    })
                  }
                  placeholder="Введи текст сценарію"
                />
                <div className="script-bottom">
                  <span>
                    {wordCount} слів · орієнтовно{' '}
                    {Math.ceil(narrationSeconds)} с озвучки
                  </span>
                  <span>{draft.script.length} / 3000</span>
                </div>
                {scriptTooLong && (
                  <p className="form-alert">Скороти сценарій або збільш тривалість відео, щоб озвучка вмістилася.</p>
                )}
                <Button className="secondary-button generate-script" onClick={generateScript}>
                  <FileText size={15} /> Заповнити за шаблоном
                </Button>
                <div className="field-divider" />
                <label className="field-label" htmlFor="tag-input">
                  Ключові слова для пошуку матеріалів
                </label>
                <div className="tags">
                  {draft.tags.map((tag) => (
                    <Button
                      key={tag}
                      onClick={() =>
                        updateDraft({
                          tags: draft.tags.filter((value) => value !== tag),
                        })
                      }
                    >
                      {tag}
                      <span>×</span>
                    </Button>
                  ))}
                </div>
                <form
                  className="tag-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const tag = tagInput.trim().toLowerCase()
                    if (tag && !draft.tags.includes(tag) && draft.tags.length < 10) {
                      updateDraft({
                        tags: [...draft.tags, tag],
                      })
                      setTagInput('')
                    }
                  }}
                >
                  <Input
                    id="tag-input"
                    maxLength={40}
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    placeholder="Додати ключове слово…"
                  />
                  <Button className="text-button" type="submit">
                    Додати
                  </Button>
                </form>
              </div>
            )}
            {step === 2 && (
              <div className="step-content">
                <div className="section-title">
                  <h3>Озвучення</h3>
                </div>
                <label className="field-label">Голос озвучки</label>
                <div className="voice-options">
                  {[
                    {
                      name: 'Остап',
                      label: 'Чоловічий · спокійний',
                      initials: 'О',
                      color: 'sage',
                    },
                    {
                      name: 'Поліна',
                      label: 'Жіночий · природний',
                      initials: 'П',
                      color: 'peach',
                    },
                  ].map((voice) => (
                    <Button
                      key={voice.name}
                      className={`voice-option ${draft.voice === voice.name ? 'selected' : ''}`}
                      onClick={() =>
                        updateDraft({
                          voice: voice.name,
                        })
                      }
                    >
                      <span className={`voice-avatar ${voice.color}`}>
                        <Mic2 size={21} />
                      </span>
                      <div>
                        <strong>{voice.name}</strong>
                        <small>{voice.label}</small>
                      </div>
                      <span className="radio-mark">{draft.voice === voice.name && <i />}</span>
                    </Button>
                  ))}
                </div>
                <audio key={voiceSample} ref={voiceAudio} src={`/assets/voices/${voiceSample}`} preload="auto"
                  onEnded={() => setVoicePlaying(false)} />
                <Button className="secondary-button voice-sample" loading={voiceLoading} onClick={() => void previewVoice()}>
                  <Play size={14} fill="currentColor" />
                  {voicePlaying ? 'Зупинити зразок' : 'Послухати зразок'}
                </Button>
                <div className="range-label">
                  <label className="field-label" htmlFor="voice-rate">
                    Швидкість мовлення
                  </label>
                  <strong>{draft.rate.toFixed(1)}×</strong>
                </div>
                <Input
                  className="setting-range"
                  id="voice-rate"
                  type="range"
                  min="0.7"
                  max="1.3"
                  step="0.1"
                  value={draft.rate}
                  onChange={(event) =>
                    updateDraft({
                      rate: Number(event.target.value),
                    })
                  }
                />
                <div className="field-divider" />
                <label className="field-label" htmlFor="music">
                  Фонова музика
                </label>
                <div className="select-wrap leading-icon">
                  <Music2 size={16} />
                  <Select
                    id="music"
                    value={draft.music}
                    onChange={(event) =>
                      updateDraft({
                        music: event.target.value,
                      })
                    }
                  >
                    {[
                      'Без музики',
                      'Спокійна атмосфера',
                      'Натхненний ритм',
                      'Легкий акустичний фон',
                    ].map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </Select>
                  <ChevronDown size={15} />
                </div>
                <label className="field-label" htmlFor="music-volume">
                  Гучність фонових доріжок · {draft.musicVolume}%
                </label>
                <Input id="music-volume" type="range" min={0} max={100} step={1}
                  value={draft.musicVolume} onChange={(event) => updateDraft({ musicVolume: Number(event.target.value) })} />
                <div className="setting-line">
                  <div>
                    <strong>Субтитри</strong>
                  </div>
                  <Toggle
                    checked={draft.subtitles}
                    onChange={(value) =>
                      updateDraft({
                        subtitles: value,
                      })
                    }
                    label="Субтитри"
                  />
                </div>
              </div>
            )}
            {step === 3 && (
              <div className="step-content">
                <div className="section-title">
                  <div>
                    <h3>Медіаматеріали</h3>
                    <p>Фото необов’язкове. Якщо стартове фото не вибране, перший кліп створюється з тексту.</p>
                  </div>
                </div>
                <div className="setting-line">
                  <strong>Перше фото як стартовий кадр</strong>
                  <Toggle label="Перше фото як стартовий кадр" checked={draft.useStartImage !== false}
                    onChange={(value) => updateDraft({ useStartImage: value })} />
                </div>
                <div className="source-tabs">
                  <Button
                    className={mediaSource === 'library' ? 'active' : ''}
                    onClick={() => setMediaSource('library')}
                  >
                    <Search size={14} /> Добірка фото
                  </Button>
                  <Button
                    className={mediaSource === 'own' ? 'active' : ''}
                    onClick={() => setMediaSource('own')}
                  >
                    <Upload size={14} /> Мої матеріали
                  </Button>
                </div>
                <div className="search-field">
                  <Search size={16} />
                  <Input
                    value={mediaQuery}
                    onChange={(event) => setMediaQuery(event.target.value)}
                    placeholder="Гори, море, місто…"
                  />
                </div>
                <div className="selection-summary">
                  <span>
                    Обрано:{' '}
                    <strong>
                      {draft.mediaIds.filter((id) => media.some((item) => item.id === id)).length}{' '}
                      матеріали
                    </strong>
                  </span>
                  <Button
                    className="text-button"
                    onClick={() =>
                      updateDraft({
                        mediaIds: [],
                      })
                    }
                  >
                    Скинути
                  </Button>
                </div>
                <div className="editor-media-grid">
                  {visibleMedia.map((item) => (
                    <MediaCard
                      key={item.id}
                      item={item}
                      selected={draft.mediaIds.includes(item.id)}
                      onSelect={() => toggleMedia(item.id)}
                    />
                  ))}
                </div>
                <Input
                  ref={uploadRef}
                  type="file"
                  accept="image/*,video/*,audio/*"
                  multiple
                  hidden
                  onChange={(event) => {
                    onUpload(event.target.files)
                    event.target.value = ''
                  }}
                />
                <Button className="upload-inline" onClick={() => uploadRef.current?.click()}>
                  <Upload size={17} />
                  <span>Завантажити свої матеріали</span>
                </Button>
              </div>
            )}
          </div>
          {generationProgress && <p className="generation-checkout" role="status">{generationProgress}</p>}
          {step === 3 && (
            <GenerationCheckout key={JSON.stringify([session.account?.id, draft.duration, draft.format])}
              session={session} duration={draft.duration} format={draft.format}
              busy={generating} onRegister={onRegister} onGenerate={async (quote) => {
                if (!validateTopic()) throw new Error('Додай тему відео.')
                if (!draft.script.trim()) {
                  onStep(1)
                  onToast('Додай текст сценарію.')
                  return
                }
                if (scriptTooLong) {
                  onStep(1)
                  throw new Error('Сценарій задовгий. Скороти його або збільш тривалість відео.')
                }
                await onGenerate(quote)
              }}
            />
          )}
          <div className="editor-footer">
            <Button className="secondary-button" onClick={step ? () => onStep(step - 1) : onSave}>
              {step ? <ArrowLeft size={15} /> : <FileText size={15} />}
              {step ? 'Назад' : 'Зберегти чернетку'}
            </Button>
            {step < 3 && <Button className="primary-button" onClick={nextStep}>
              {step === 0 ? 'До сценарію' : 'Наступний крок'} <ArrowRight size={16} />
            </Button>}
          </div>
        </section>
        <aside className="preview-panel">
          <div className="preview-heading">
            <h2>Попередній перегляд</h2>
            <Button
              className="icon-button"
              aria-label="Розгорнути попередній перегляд"
              onClick={onExpand}
              disabled={!previewProject}
            >
              <Maximize2 size={17} />
            </Button>
          </div>

          <Preview key={previewProject?.id} draft={previewProject} media={media} />
        </aside>
      </div>
    </>
  )
}
