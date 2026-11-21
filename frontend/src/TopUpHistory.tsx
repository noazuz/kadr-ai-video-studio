import { useEffect, useState } from 'react'
import { ApiError, cancelTopUp, getTopUps, messageOf, usd } from './api'
import type { TopUpRequest } from './types'
import { Button } from './ui-kit'

const statusLabel = {
  pending: 'Очікує підтвердження',
  approved: 'Зараховано',
  rejected: 'Відхилено',
  canceled: 'Скасовано',
}
const dateFormat = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Kyiv',
})

export default function TopUpHistory({ accountId, refreshBalance }: {
  accountId: string
  refreshBalance: () => void
}) {
  const [request, setRequest] = useState<{ cursor: string | null }>({ cursor: null })
  const [entries, setEntries] = useState<TopUpRequest[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [canceling, setCanceling] = useState<string | null>(null)
  const [cancelError, setCancelError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    getTopUps(accountId, request.cursor, controller.signal).then((page) => {
      if (controller.signal.aborted) return
      setEntries((previous) => request.cursor ? [...previous, ...page.results] : page.results)
      setNextCursor(page.next_cursor)
      setLoading(false)
    }).catch((cause) => {
      if (controller.signal.aborted) return
      setLoading(false)
      setError(messageOf(cause))
      if (cause instanceof ApiError && cause.status === 401) refreshBalance()
    })
    return () => controller.abort()
  }, [accountId, refreshBalance, request])

  const load = (cursor: string | null) => {
    setLoading(true)
    setError('')
    setRequest({ cursor })
  }

  const cancel = async (id: string) => {
    setCanceling(id)
    setCancelError('')
    try {
      const updated = await cancelTopUp(id)
      setEntries((items) => items.map((entry) => entry.id === id ? updated : entry))
    } catch (cause) {
      setCancelError(messageOf(cause))
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 401)) {
        load(null)
        refreshBalance()
      }
    } finally {
      setCanceling(null)
    }
  }

  return (
    <section className="account-history-section" aria-labelledby="top-up-history-title">
      <h3 id="top-up-history-title">Заявки на поповнення</h3>
      <ul className="expense-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <div>
              <span>{statusLabel[entry.status]}</span>
              <time dateTime={entry.resolved_at ?? entry.created_at}>
                {dateFormat.format(new Date(entry.resolved_at ?? entry.created_at))}
              </time>
              {entry.status === 'pending' && (
                <Button className="form-link" disabled={loading || canceling !== null}
                  loading={canceling === entry.id} onClick={() => void cancel(entry.id)}>Скасувати заявку</Button>
              )}
            </div>
            <strong>{entry.status === 'approved' ? '+' : ''}{usd(entry.amount_cents)}</strong>
          </li>
        ))}
      </ul>
      {loading && <p role="status">Завантажуємо заявки…</p>}
      {error && <p className="form-alert" role="alert">{error}</p>}
      {cancelError && <p className="form-alert" role="alert">{cancelError}</p>}
      {!loading && !error && !entries.length && <p>Заявок ще немає.</p>}
      <Button className="form-link" disabled={loading || canceling !== null} onClick={() => { load(null); refreshBalance() }}>
        Оновити заявки й баланс
      </Button>
      {!loading && !error && nextCursor && (
        <Button className="form-link" disabled={canceling !== null} onClick={() => load(nextCursor)}>Показати ще</Button>
      )}
    </section>
  )
}
