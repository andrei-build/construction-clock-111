// FILES-VIEWER-37: чистая логика встроенного полноэкранного просмотрщика файлов.
// Вынесено из FileViewer.tsx, чтобы покрыть юнит-тестами без DOM (vitest node-env).
// Имя *Core, а не fileViewer.ts, чтобы не конфликтовать с FileViewer.tsx на case-insensitive FS.
// Никаких React/браузерных зависимостей здесь быть не должно.

export type FileViewKind = 'pdf' | 'image' | 'other'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'heif'])

// Определяем вид файла для выбора рендерера: по MIME, с запасным вариантом по расширению имени
// (иногда mime приходит пустым/generic — тогда решает расширение).
export function fileViewKind(mime: string | null | undefined, name?: string | null): FileViewKind {
  const m = (mime ?? '').toLowerCase().trim()
  if (m.startsWith('image/')) return 'image'
  if (m === 'application/pdf' || m === 'application/x-pdf') return 'pdf'
  const ext = (name ?? '').toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXT.has(ext)) return 'image'
  return 'other'
}

// Кламп номера страницы PDF в диапазон [1..total]. total может быть неизвестен (браузерный
// PDF-вьювер не сообщает число страниц без pdf.js) — тогда ограничиваем только снизу единицей.
export function clampPage(page: number, total?: number | null): number {
  const p = Number.isFinite(page) ? Math.round(page) : 1
  const lo = Math.max(1, p)
  if (total != null && Number.isFinite(total) && total >= 1) return Math.min(lo, Math.round(total))
  return lo
}

export const MIN_SCALE = 1
export const MAX_SCALE = 6

// Кламп масштаба (зум изображения) в [min..max]. NaN/Infinity → min.
export function clampScale(scale: number, min: number = MIN_SCALE, max: number = MAX_SCALE): number {
  if (!Number.isFinite(scale)) return min
  return Math.min(max, Math.max(min, scale))
}

// Собираем src для встроенного PDF-вьювера браузера: URL + якорь страницы и вписывание по ширине.
// Практика (замер FILES-VIEWER-37): Chromium/Edge внутри <iframe> игнорируют #page=N, поэтому это
// используется лишь для НАЧАЛЬНОГО вида (page=1, FitH); дальнейшую навигацию/зум даёт нативный тулбар
// вьювера. clampPage оставлен как каноничная логика клампа [1..total] (тест + запас для #38/#39).
export function pdfPageSrc(url: string, page: number): string {
  const p = clampPage(page)
  const base = url.split('#')[0]
  return `${base}#page=${p}&view=FitH`
}
