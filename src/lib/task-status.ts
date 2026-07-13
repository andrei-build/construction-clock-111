import type { Task } from './types'

// Эффективный статус задачи: done_at — источник правды (паритет с Check Time).
// Строка status может отставать от факта закрытия, поэтому проставленный done_at
// считаем «done» независимо от status. Только чтение/деривация — писателя тут нет.

// Минимальная структурная форма: совместима с реальным Task, но не требует его целиком.
type TaskStatusShape = Pick<Task, 'status'> & { done_at?: string | null }
type TaskLike = { status?: TaskStatusShape['status'] | null; done_at?: string | null }

// Завершена, если проставлен done_at ЛИБО status === 'done' (done_at авторитетнее).
export function isEffectiveCompletedTask(task: TaskLike): boolean {
  return Boolean(task.done_at) || task.status === 'done'
}

// Открыта, если НЕ завершена и не отменена (open / in_progress без done_at).
export function isEffectiveOpenTask(task: TaskLike): boolean {
  return !isEffectiveCompletedTask(task) && task.status !== 'cancelled'
}
