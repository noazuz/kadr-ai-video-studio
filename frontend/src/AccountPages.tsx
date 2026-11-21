import { useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ArrowRight, Eye, EyeOff, History, KeyRound, LogOut, Plus, UserRound, Wallet } from 'lucide-react'
import { ApiError, authenticate, changePassword, logout, messageOf, requestPasswordReset, resetPassword, saveProfile, submitTopUp, usd } from './api'
import { Button, Field, Input } from './ui-kit'
import type { Account, AuthView, View } from './types'
import type { Session } from './useSession'
import ExpenseHistory from './ExpenseHistory'
import TopUpHistory from './TopUpHistory'

const authTitles: Record<AuthView, string> = {
  login: 'Вхід до акаунта',
  register: 'Створити акаунт',
  'forgot-password': 'Відновити пароль',
  'reset-password': 'Новий пароль',
}

function Form({ children, submit, label, onError }: {
  children?: ReactNode
  submit: (data: FormData) => Promise<string | void>
  label: string
  onError?: (error: unknown) => void
}) {
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (lock.current) return
    const form = event.currentTarget
    const data = new FormData(form)
    lock.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await submit(data)
      if (result) {
        form.reset()
        setMessage(result)
      }
    } catch (cause) {
      setError(messageOf(cause))
      onError?.(cause)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <form className="account-form" onSubmit={handleSubmit}>
      <fieldset disabled={busy}>{children}</fieldset>
      {error && <p className="form-alert" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
      <Button type="submit" className="primary-button" loading={busy}>{label}</Button>
    </form>
  )
}

function PasswordField({ name, label, current = false }: { name: string; label: string; current?: boolean }) {
  const [visible, setVisible] = useState(false)
  return (
    <Field id={name} label={label}>
      <div className="password-field">
        <Input className="full-input" name={name} required type={visible ? 'text' : 'password'}
          autoComplete={current ? 'current-password' : 'new-password'} minLength={current ? undefined : 8} />
        <Button className="icon-button" aria-label={visible ? 'Приховати пароль' : 'Показати пароль'}
          aria-pressed={visible} onClick={() => setVisible(!visible)}>
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </Button>
      </div>
    </Field>
  )
}

const field = (data: FormData, name: string) => String(data.get(name) ?? '')

function newPassword(data: FormData) {
  const password = field(data, 'password')
  if (password !== field(data, 'confirmation')) throw new Error('Введені паролі мають збігатися.')
  return password
}

export function AuthPage({ mode, onNavigate, onAuthenticated, resetQuery }: {
  mode: AuthView
  onNavigate: (view: View) => void
  onAuthenticated: (account: Account) => void
  resetQuery: string
}) {
  const [done, setDone] = useState(false)
  const params = new URLSearchParams(resetQuery)
  const uid = params.get('uid')
  const token = params.get('token')
  const invalidLink = mode === 'reset-password' && (!uid || !token)
  const register = mode === 'register'
  const login = mode === 'login'
  const submit = async (data: FormData) => {
    const email = field(data, 'email').trim()
    if (mode === 'forgot-password') {
      await requestPasswordReset(email)
      setDone(true)
    } else if (mode === 'reset-password' && uid && token) {
      await resetPassword(uid, token, newPassword(data))
      window.history.replaceState(null, '', '#reset-password')
      setDone(true)
    } else if (login || register) {
      const fields: Record<string, string> = { email, password: register ? newPassword(data) : field(data, 'password') }
      if (register) {
        fields.name = field(data, 'name').trim()
        if (!fields.name) throw new Error('Введи ім’я.')
      }
      onAuthenticated(await authenticate(mode, fields))
    }
  }
  return (
    <section className="auth-layout">
      <div className="auth-content">
        <h1>{authTitles[mode]}</h1>
        {done ? (
          <div className="auth-message" role="status">
            <p>{mode === 'forgot-password' ? 'Якщо акаунт із цією адресою існує, на пошту надійде посилання для зміни пароля.' : 'Пароль змінено. Тепер можна увійти до акаунта.'}</p>
            <Button className="secondary-button" onClick={() => onNavigate('login')}>До входу <ArrowRight size={15} /></Button>
          </div>
        ) : invalidLink ? (
          <div className="auth-message">
            <p>У посиланні бракує даних для зміни пароля.</p>
            <Button className="secondary-button" onClick={() => onNavigate('forgot-password')}>Запросити нове посилання</Button>
          </div>
        ) : (
          <>
            {register && params.get('next') === 'studio' && (
              <p className="auth-help">Спочатку зареєструйся, щоб згенерувати відео.</p>
            )}
            {mode === 'forgot-password' && <p className="auth-help">Вкажи пошту, з якою ти реєструвався в Кадрі.</p>}
            <Form submit={submit} label={login ? 'Увійти' : register ? 'Зареєструватися' : mode === 'forgot-password' ? 'Надіслати посилання' : 'Зберегти пароль'}>
              {register && <Field id="name" label="Ім’я"><Input className="full-input" name="name" autoComplete="name" maxLength={100} required /></Field>}
              {mode !== 'reset-password' && <Field id="email" label="Електронна пошта"><Input className="full-input" type="email" name="email" autoComplete="email" placeholder="name@example.com" required /></Field>}
              {mode !== 'forgot-password' && <PasswordField name="password" label={login ? 'Пароль' : 'Пароль (від 8 символів)'} current={login} />}
              {(register || mode === 'reset-password') && <PasswordField name="confirmation" label="Підтвердження пароля" />}
              {login && <Button className="form-link forgot-link" onClick={() => onNavigate('forgot-password')}>Забули пароль?</Button>}
            </Form>
            <div className="auth-switch">
              {login ? 'Ще немає акаунта?' : register ? 'Уже є акаунт?' : ''}
              <Button className="form-link" onClick={() => onNavigate(login ? 'register' : 'login')}>
                {login ? 'Зареєструватися' : 'До входу'} <ArrowRight size={14} />
              </Button>
            </div>
          </>
        )}
      </div>
      <div className="auth-photo" aria-hidden="true"><span /></div>
    </section>
  )
}

function AccountWallet({ account, session, onSubmitted }: { account: Account; session: Session; onSubmitted: () => void }) {
  const [open, setOpen] = useState(false)
  const [amountInput, setAmountInput] = useState('')
  const [notice, setNotice] = useState('')
  const requestId = useRef<string | null>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const ready = session.status === 'ready'
  const submit = async (data: FormData) => {
    const raw = field(data, 'top-up-amount').trim()
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw)) throw new Error('Введи суму з точністю до двох знаків після коми.')
    const [whole, fractional = ''] = raw.replace(',', '.').split('.')
    const amount = Number(whole) * 100 + Number(fractional.padEnd(2, '0'))
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000) {
      throw new Error('Введи суму від $0.01 до $10,000.00.')
    }
    requestId.current ??= crypto.randomUUID()
    await submitTopUp(account.id, amount, requestId.current)
    requestId.current = null
    setAmountInput('')
    setOpen(false)
    setNotice('Заявку на ' + usd(amount) + ' надіслано адміністратору.')
    onSubmitted()
    toggle.current?.focus()
  }
  return (
    <section className="wallet-card">
      <h2><Wallet size={18} /> Баланс акаунта</h2>
      <strong>{ready ? usd(account.balance_cents) : '—'}</strong>
      <span>Долари США</span>
      <Button ref={toggle} className="secondary-button wallet-toggle" disabled={!ready}
        aria-expanded={open && ready} aria-controls="wallet-top-up" onClick={() => {
          setNotice('')
          setOpen(!open)
        }}>
        <Plus size={16} aria-hidden="true" /> Поповнити баланс
      </Button>
      <div id="wallet-top-up" className="wallet-top-up" hidden={!open || !ready}>
        <p>Баланс зміниться після підтвердження адміністратором.</p>
        <Form submit={submit} label="Надіслати заявку" onError={(error) => {
          if (error instanceof ApiError && error.status === 401) void session.refreshAllTabs()
        }}>
          <Field id="top-up-amount" label="Сума в USD">
            <Input className="full-input" name="top-up-amount" inputMode="decimal" value={amountInput} required
              maxLength={12} placeholder="Наприклад, 12.50" onChange={(event) => {
                requestId.current = null
                setAmountInput(event.target.value)
              }} />
          </Field>
        </Form>
      </div>
      {notice && <p className="wallet-notice" role="status">{notice}</p>}
    </section>
  )
}

export function AccountPage({ account, session, onLogout }: { account: Account; session: Session; onLogout: () => void }) {
  const [email, setEmail] = useState(account.email)
  const [logoutError, setLogoutError] = useState('')
  const [leaving, setLeaving] = useState(false)
  const [topUpRevision, setTopUpRevision] = useState(0)
  const emailChanged = email.trim() !== account.email
  const handleError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) session.replace(null)
  }
  return (
    <div className="account-layout">
      <div className="account-panels">
        <section className="account-panel">
          <h2><UserRound size={19} /> Особисті дані</h2>
          <Form label="Зберегти зміни" onError={handleError} submit={async (data) => {
            const fields: Record<string, string> = { name: field(data, 'name').trim(), email: email.trim() }
            if (!fields.name) throw new Error('Введи ім’я.')
            if (emailChanged) fields.current_password = field(data, 'profile-password')
            const saved = await saveProfile(fields)
            setEmail(saved.email)
            session.replace(saved)
            return 'Дані акаунта збережено.'
          }}>
            <Field id="name" label="Ім’я"><Input className="full-input" name="name" defaultValue={account.name} maxLength={100} autoComplete="name" required /></Field>
            <Field id="email" label="Електронна пошта"><Input className="full-input" name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            {emailChanged && <PasswordField name="profile-password" label="Підтвердь зміну пошти поточним паролем" current />}
          </Form>
        </section>
        <section className="account-panel">
          <h2><KeyRound size={19} /> Зміна пароля</h2>
          <Form label="Змінити пароль" onError={handleError} submit={async (data) => {
            await changePassword(field(data, 'current-password'), newPassword(data))
            return 'Пароль змінено.'
          }}>
            <PasswordField name="current-password" label="Поточний пароль" current />
            <PasswordField name="password" label="Новий пароль (від 8 символів)" />
            <PasswordField name="confirmation" label="Підтвердження пароля" />
          </Form>
        </section>
      </div>
      <aside className="account-side">
        <AccountWallet account={account} session={session} onSubmitted={() => setTopUpRevision((value) => value + 1)} />
        {session.status === 'unavailable' && <Button className="secondary-button" onClick={session.refresh}>Оновити баланс</Button>}
        <section className="account-panel expense-history" aria-labelledby="account-history-title">
          <h2 id="account-history-title"><History size={19} /> Історія балансу</h2>
          <TopUpHistory key={topUpRevision} accountId={account.id} refreshBalance={session.refreshAllTabs} />
          <ExpenseHistory key={account.total_spent_cents ?? account.balance_cents}
            accountId={account.id}
            totalSpent={session.status === 'ready' ? account.total_spent_cents : null}
            onUnauthorized={session.refresh} />
        </section>
        <Button className="secondary-button logout-button" loading={leaving} onClick={async () => {
          setLeaving(true)
          setLogoutError('')
          try { await logout(); onLogout() }
          catch (error) {
            if (error instanceof ApiError && error.status === 401) onLogout()
            else setLogoutError(messageOf(error))
          } finally { setLeaving(false) }
        }}><LogOut size={16} /> Вийти з акаунта</Button>
        {logoutError && <p role="alert" className="form-alert">{logoutError}</p>}
      </aside>
    </div>
  )
}
