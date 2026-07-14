import { useState, type ReactNode } from 'react'
import { IconChevron } from './icons'

export default function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string
  count: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className={`collapsible ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="collapsible-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="collapsible-title">{title}</span>
        <span className="collapsible-count">{count}</span>
        <IconChevron className="collapsible-chevron" />
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  )
}
