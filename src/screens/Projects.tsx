import { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth'
import { useI18n } from '../lib/i18n'
import { getProjects, getOpenTasks, createProject, markTaskDone } from '../lib/api'
import { isManagerWrite } from '../lib/types'
import type { Project, Task } from '../lib/types'

export default function Projects() {
  const { profile } = useAuth()
  const { t } = useI18n()
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () => Promise.all([getProjects(), getOpenTasks()]).then(([p, tk]) => { setProjects(p); setTasks(tk) })
  useEffect(() => { load() }, [profile?.id])

  const canWrite = profile ? isManagerWrite(profile.role) : false

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!profile || !name.trim()) return
    setBusy(true)
    try {
      await createProject(profile, name.trim(), address.trim())
      setName(''); setAddress(''); setAdding(false)
      await load()
    } catch { /* показывается пустым — RLS не пустит не-менеджера */ }
    setBusy(false)
  }

  const done = async (task: Task) => {
    if (!profile) return
    await markTaskDone(profile, task)
    await load()
  }

  const prio = (p: Task['priority']) => p === 'urgent' ? 'red' : p === 'high' ? 'amber' : 'blue'

  return (
    <div className="screen">
      <h1>📁 {t('projects')}</h1>

      {canWrite && !adding && (
        <button className="btn ghost small" onClick={() => setAdding(true)}>+ {t('add_project')}</button>
      )}
      {adding && (
        <form onSubmit={submit} className="card">
          <label>{t('name')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>{t('address')}</label>
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
          <button className="btn" disabled={busy || !name.trim()}>{t('create')}</button>
        </form>
      )}

      {projects.map((p) => {
        const ptasks = tasks.filter((tk) => tk.project_id === p.id)
        return (
          <div key={p.id} className="card">
            <div style={{ fontWeight: 700, fontSize: 17 }}>{p.name}</div>
            <div className="muted">{p.address}</div>
            {ptasks.length > 0 && <h2>{t('tasks')}</h2>}
            {ptasks.map((tk) => (
              <div key={tk.id} className="row" style={{ padding: '6px 0' }}>
                <div>
                  <span className={`badge ${prio(tk.priority)}`}>{tk.task_type === 'delivery' ? '🚚' : tk.task_type === 'material' ? '📦' : '🔨'}</span>{' '}
                  {tk.title}
                </div>
                <button className="btn ghost small" onClick={() => done(tk)}>{t('done')}</button>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
