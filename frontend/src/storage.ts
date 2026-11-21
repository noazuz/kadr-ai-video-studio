
import { useEffect, useRef, useState } from 'react'

export function useStoredState<T>(
  key: string,
  initial: T,
  validate?: (item: unknown) => boolean
) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)

      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw)

        if (!validate || validate(parsed)) {
          return parsed as T
        }
      }
    } catch (error) {
      console.error(`Помилка читання ${key}:`, error)
    }

    return initial
  })

  const [loaded, setLoaded] = useState(false)
  const lastSaved = useRef<string | null>(null)

  useEffect(() => {
    setLoaded(true)
  }, [])

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== key || event.storageArea !== localStorage || !event.newValue) return
      try {
        if (event.newValue !== localStorage.getItem(key)) return
        const parsed: unknown = JSON.parse(event.newValue)
        if (!validate || validate(parsed)) {
          lastSaved.current = event.newValue
          setValue(parsed as T)
        }
      } catch {
        return
      }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [key, validate])

  useEffect(() => {
    if (!loaded) return

    try {
      if (validate && !validate(value)) {
        console.error(`Дані ${key} не пройшли перевірку — збереження скасовано`)
        return
      }

      const serialized = JSON.stringify(value)
      if (lastSaved.current !== serialized) {
        localStorage.setItem(key, serialized)
        lastSaved.current = serialized
      }
    } catch (error) {
      console.error(`Помилка збереження ${key}:`, error)
    }
  }, [key, value, loaded, validate])

  return [value, setValue] as const
}

export function downloadFile(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function createSubtitles(script: string, duration: number) {
  const lines = script.split(/(?<=[.!?])\s+/).filter(Boolean)
  const formatTime = (value: number) => {
    const ms = Math.round(value * 1000)
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
  }
  return lines
    .map(
      (line, i) =>
        `${i + 1}\n${formatTime((i * duration) / lines.length)} --> ${formatTime(((i + 1) * duration) / lines.length)}\n${line}`
    )
    .join('\n\n')
}

export function projectDate(value: string) {
  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(value))
}
