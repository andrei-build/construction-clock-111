import type { WorkInterval } from './types'

// F15 — обзорный сигнал: разрыв между уходом с проекта A и приходом на проект B в ТОТ ЖЕ день.
// Только для показа: не меняет часы/оплату/итоги. Порог WARNING >= 30м, CRITICAL >= 90м.
export const GAP_WARNING_MS = 30 * 60 * 1000
export const GAP_CRITICAL_MS = 90 * 60 * 1000

export type TransferGapTier = 'warning' | 'critical'

export interface TransferGap {
  // Ключ дня (устройство-локальный календарный день) + время следующего входа — для стабильного React key.
  key: string
  dayKey: string
  fromProjectId: string | null
  toProjectId: string | null
  gapMs: number
  tier: TransferGapTier
}

// Локальный календарный день интервала: YYYY-M-D в TZ устройства (тот же приём, что startOfDay в экране).
function localDayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

// Разрывы перехода между проектами в один день. Берём только ЗАКРЫТЫЕ интервалы (есть end_at),
// сортируем по времени старта; между соседними интервалами одного дня с РАЗНЫМИ проектами
// разрыв = start(next) - end(prev). Эмитим только разрывы >= GAP_WARNING_MS.
export function computeTransferGaps(intervals: WorkInterval[]): TransferGap[] {
  const closed = intervals
    .filter((interval) => interval.end_at !== null)
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())

  const gaps: TransferGap[] = []
  for (let i = 0; i < closed.length - 1; i++) {
    const prev = closed[i]
    const next = closed[i + 1]
    const prevDay = localDayKey(prev.start_at)
    const nextDay = localDayKey(next.start_at)
    // Тот же локальный день и РАЗНЫЕ проекты — иначе это не переход между объектами.
    if (prevDay !== nextDay) continue
    if (prev.project_id === next.project_id) continue

    const prevEnd = new Date(prev.end_at as string).getTime()
    const nextStart = new Date(next.start_at).getTime()
    const gapMs = nextStart - prevEnd
    if (gapMs < GAP_WARNING_MS) continue

    gaps.push({
      key: `${prevDay}-${prev.end_event_id ?? prev.start_event_id}-${next.start_event_id}`,
      dayKey: prevDay,
      fromProjectId: prev.project_id,
      toProjectId: next.project_id,
      gapMs,
      tier: gapMs >= GAP_CRITICAL_MS ? 'critical' : 'warning',
    })
  }
  return gaps
}
