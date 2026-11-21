import { useEffect, useRef, useState } from 'react'
import { Film, Wallet } from 'lucide-react'
import { ApiError, getQuote, messageOf, usd } from './api'
import type { GenerationQuote, VideoFormat } from './types'
import type { Session } from './useSession'
import { Button } from './ui-kit'

export default function GenerationCheckout({ session, duration, format, busy, onRegister, onGenerate }: {
  session: Session
  duration: number
  format: VideoFormat
  busy: boolean
  onRegister: () => void
  onGenerate: (quote: GenerationQuote) => Promise<void>
}) {
  const [quote, setQuote] = useState<GenerationQuote | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const active = useRef(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])
  const accountId = session.account?.id
  const { setBalance, replace, refresh, status } = session
  const retry = () => {
    setQuote(null)
    setError('')
    setAttempt((value) => value + 1)
  }
  useEffect(() => {
    setQuote(null)
    setError('')
    if (!accountId || status !== 'ready') return
    const controller = new AbortController()
    getQuote(accountId, duration, format, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setBalance(accountId, result.balance_cents)
      setQuote(result)
    }).catch((cause) => {
      if (controller.signal.aborted) return
      if (cause instanceof ApiError && cause.status === 401) replace(null)
      else setError(messageOf(cause))
    })
    return () => controller.abort()
  }, [accountId, duration, format, status, attempt, setBalance, replace])

  const balance = session.account?.balance_cents
  const shortfall = quote && balance !== undefined ? Math.max(0, quote.price_cents - balance) : 0
  const generate = async () => {
    if (!quote || shortfall || busy || status !== 'ready') return
    setError('')
    try {
      await onGenerate(quote)
      if (active.current) retry()
    } catch (cause) {
      if (!active.current) return
      if (cause instanceof ApiError && cause.status === 401) {
        replace(null)
        return
      }
      if (cause instanceof ApiError && ([402, 409].includes(cause.status) || cause.status >= 500)) {
        setQuote(null)
        void refresh()
      }
      setError(messageOf(cause))
    }
  }
  return (
    <section className="generation-checkout" aria-label="Оплата генерації">
      <div className="quote-line"><span><Wallet size={16} /> Вартість генерації</span>
        <strong>{quote && status === 'ready' ? usd(quote.price_cents) : '—'}</strong>
      </div>
      {quote && status === 'ready' && <p>Тривалість кліпу — {quote.duration} с. Баланс — {usd(balance ?? 0)}.</p>}
      {shortfall > 0 && <p className="form-alert">Для генерації бракує {usd(shortfall)}.</p>}
      {error && <p role="alert" className="form-alert">{error}</p>}
      {status === 'loading' ? <p role="status">Перевіряємо сеанс…</p>
        : !accountId ? (
          <Button className="primary-button" onClick={onRegister}><Film size={16} /> Згенерувати відео</Button>
        )
        : status === 'unavailable' ? <><p>Баланс тимчасово недоступний.</p><Button className="secondary-button" onClick={refresh}>Оновити баланс</Button></>
        : <>
          {!quote && !error && <p role="status">Отримуємо ціну…</p>}
          {(shortfall > 0 || (!quote && error)) && <Button className="form-link" onClick={retry}>Оновити ціну й баланс</Button>}
          <Button className="primary-button" disabled={!quote || shortfall > 0 || busy} loading={busy} onClick={generate}>
            <Film size={16} /> {busy ? 'Генеруємо відео…' : quote ? 'Згенерувати за ' + usd(quote.price_cents) : 'Згенерувати відео'}
          </Button>
        </>}
    </section>
  )
}
