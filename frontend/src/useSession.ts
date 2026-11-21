import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, getAccount } from './api'
import type { Account } from './types'

export function useSession() {
  const [account, setAccount] = useState<Account | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const revision = useRef(0)
  const channel = useRef<BroadcastChannel | null>(null)

  const replace = useCallback((value: Account | null) => {
    revision.current++
    setAccount(value)
    setStatus('ready')
    channel.current?.postMessage('changed')
  }, [])

  const refresh = useCallback(async () => {
    const current = ++revision.current
    try {
      const value = await getAccount()
      if (current !== revision.current) return
      setAccount(value)
      setStatus('ready')
    } catch (error) {
      if (current !== revision.current) return
      if (error instanceof ApiError && error.status === 401) {
        setAccount(null)
        setStatus('ready')
      } else {
        setStatus('unavailable')
      }
    }
  }, [])

  const setBalance = useCallback((id: string, balance_cents: number) => {
    setAccount((value) => value?.id === id ? { ...value, balance_cents } : value)
  }, [])

  const refreshAllTabs = useCallback(() => {
    channel.current?.postMessage('changed')
    return refresh()
  }, [refresh])

  useEffect(() => {
    void refresh()
    const visible = () => { if (!document.hidden) void refresh() }
    if ('BroadcastChannel' in window) {
      channel.current = new BroadcastChannel('kadr-session')
      channel.current.onmessage = refresh
    }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('online', refresh)
    return () => {
      revision.current++
      channel.current?.close()
      channel.current = null
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('online', refresh)
    }
  }, [refresh])

  return { account, status, replace, refresh, refreshAllTabs, setBalance }
}

export type Session = ReturnType<typeof useSession>
