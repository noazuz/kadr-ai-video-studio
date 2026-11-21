import { useEffect, useState } from 'react'
import { ApiError, getExpenses, messageOf, usd } from './api'
import type { ExpensePage } from './types'
import { Button } from './ui-kit'

const expenseDate = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Europe/Kyiv',
})

export default function ExpenseHistory({ accountId, totalSpent, onUnauthorized }: {
  accountId: string
  totalSpent?: number | null
  onUnauthorized: () => void
}) {
  const [request, setRequest] = useState<{ cursor: string | null }>({ cursor: null })
  const [page, setPage] = useState<ExpensePage>({ results: [], next_cursor: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    getExpenses(accountId, request.cursor, signal).then((next) => {
      if (signal.aborted) return
      setPage((previous) => {
        if (request.cursor === null) return next
        const entries = new Map(previous.results.map((entry) => [entry.id, entry]))
        for (const entry of next.results) entries.set(entry.id, entry)
        return { results: Array.from(entries.values()), next_cursor: next.next_cursor }
      })
      setLoading(false)
    }).catch((cause) => {
      if (signal.aborted) return
      setError(messageOf(cause))
      setLoading(false)
      if (cause instanceof ApiError && cause.status === 401) onUnauthorized()
    })
    return () => controller.abort()
  }, [accountId, request, onUnauthorized])

  const loadPage = (cursor: string | null) => {
    setLoading(true)
    setError('')
    setRequest({ cursor })
  }

  return (
    <section className="account-history-section" aria-labelledby="expense-history-title">
      <h3 id="expense-history-title">Платежі за генерації</h3>
      {page.results.length > 0 && (
        <ul className="expense-list">
          {page.results.map((entry) => (
            <li key={entry.id}>
              <div>
                <span>{entry.project_title?.trim() || 'Генерація відео'}</span>
                <time dateTime={entry.created_at}>{expenseDate.format(new Date(entry.created_at))}</time>
              </div>
              <strong>−{usd(entry.amount_cents)}</strong>
            </li>
          ))}
        </ul>
      )}
      {loading && <p role="status">Завантажуємо списання…</p>}
      {!loading && !error && !page.results.length && <p>Списань за генерації ще немає.</p>}
      {error && <p className="form-alert" role="alert">{error}</p>}
      {!loading && (error || page.next_cursor) && (
        <Button className="form-link" onClick={() => loadPage(error ? request.cursor : page.next_cursor)}>
          {error ? 'Спробувати ще раз' : 'Показати ще'}
        </Button>
      )}
      {totalSpent != null && (
        <dl className="expense-total"><dt>Витрати за весь час</dt><dd>{usd(totalSpent)}</dd></dl>
      )}
    </section>
  )
}
