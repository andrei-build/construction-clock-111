import { useEffect, useState, type FormEvent } from 'react'
import { useI18n } from '../lib/i18n'
import type { Account, AccountInput, AccountType } from '../lib/types'

const ACCOUNT_TYPES: AccountType[] = ['client', 'gc', 'supplier', 'other']

function nullable(value: string) {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function initialAccountType(account?: Account | null): AccountType {
  return ACCOUNT_TYPES.includes(account?.account_type as AccountType) ? account!.account_type as AccountType : 'client'
}

export default function AccountForm({
  initial,
  submitting,
  submitLabel,
  submittingLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Account | null
  submitting: boolean
  submitLabel: string
  submittingLabel: string
  onSubmit: (input: AccountInput) => Promise<void> | void
  onCancel?: () => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(initial?.name ?? '')
  const [accountType, setAccountType] = useState<AccountType>(initialAccountType(initial))
  const [email, setEmail] = useState(initial?.email ?? '')
  const [phone, setPhone] = useState(initial?.phone ?? '')
  const [address, setAddress] = useState(initial?.address ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')

  useEffect(() => {
    setName(initial?.name ?? '')
    setAccountType(initialAccountType(initial))
    setEmail(initial?.email ?? '')
    setPhone(initial?.phone ?? '')
    setAddress(initial?.address ?? '')
    setNotes(initial?.notes ?? '')
  }, [initial?.id])

  function submit(e: FormEvent) {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName || submitting) return
    onSubmit({
      name: trimmedName,
      account_type: accountType,
      email: nullable(email),
      phone: nullable(phone),
      address: nullable(address),
      notes: nullable(notes),
    })
  }

  return (
    <form className="account-form" onSubmit={submit}>
      <label>{t('name')}</label>
      <input value={name} onChange={(e) => setName(e.target.value)} required />

      <label>{t('account_type')}</label>
      <select value={accountType} onChange={(e) => setAccountType(e.target.value as AccountType)}>
        {ACCOUNT_TYPES.map((type) => (
          <option key={type} value={type}>{t(`account_type_${type}`)}</option>
        ))}
      </select>

      <label>{t('email')}</label>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

      <label>{t('phone')}</label>
      <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />

      <label>{t('address')}</label>
      <input value={address} onChange={(e) => setAddress(e.target.value)} />

      <label>{t('notes')}</label>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />

      <div className="account-form-actions">
        {onCancel && (
          <button type="button" className="btn ghost" disabled={submitting} onClick={onCancel}>
            {t('cancel')}
          </button>
        )}
        <button type="submit" className="btn" disabled={submitting || !name.trim()}>
          {submitting ? submittingLabel : submitLabel}
        </button>
      </div>
    </form>
  )
}
