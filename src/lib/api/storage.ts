import { supabase, SUPABASE_URL, SUPABASE_KEY } from '../supabase'
import { logEvent, warnReadError } from './_shared'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'


// Тип медиа по MIME/имени для строки media (media_type — свободный text в живой схеме).
export function inferMediaType(file: { type?: string | null; name?: string | null }): 'photo' | 'video' | 'file' {
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('image/')) return 'photo'
  if (type.startsWith('video/')) return 'video'
  const name = file.name || ''
  const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : ''
  if (FILE_IMAGE_EXTS.includes(ext)) return 'photo'
  return 'file'
}

export const TASK_MEDIA_BUCKET = 'media'
// TEAM-2: ПУБЛИЧНЫЙ bucket аватаров (migration 0034). insert/update-политики для manager+.
export const AVATARS_BUCKET = 'avatars'

// ── Лимиты медиа и MIME-whitelist (паритет со старым STORAGE_LIMITS_MB) ─────────
// Единый клиентский гейт: считаем перед КАЖДОЙ загрузкой, чтобы не жечь storage/R2.
// Валидация только на клиенте — RLS/storage-политики не трогаем.
export const STORAGE_LIMITS = {
  photo: 20 * 1024 * 1024,   // 20 MB
  video: 500 * 1024 * 1024,  // 500 MB
  pdf: 50 * 1024 * 1024,     // 50 MB
} as const

const DEFAULT_FILE_LIMIT = 50 * 1024 * 1024 // дефолт для произвольных документов

const MIME_WHITELIST: Record<'photo' | 'video' | 'pdf', readonly string[]> = {
  photo: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  pdf: ['application/pdf'],
}

// Расширенный whitelist для «Файлы и документы» (Files.tsx): pdf + любые image/* + офис-типы.
const FILE_OFFICE_MIME: readonly string[] = [
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'text/csv',
  'text/plain',
]

const FILE_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif']

// Бросает Error с message-кодом 'file_too_large' | 'file_type_not_allowed'.
// Экраны показывают эти коды через t(...). Вызывать ПЕРВОЙ строкой (до сети).
export function validateUpload(
  file: { size: number; type?: string; name?: string },
  kind: 'photo' | 'video' | 'pdf' | 'file',
): void {
  const type = (file.type || '').toLowerCase()

  if (kind === 'file') {
    // Лимит по факту типа: pdf→pdf, картинка→photo, иначе дефолт 50MB.
    const name = file.name || ''
    const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : ''
    let limit = DEFAULT_FILE_LIMIT
    if (type === 'application/pdf' || ext === 'pdf') limit = STORAGE_LIMITS.pdf
    else if (type.startsWith('image/') || FILE_IMAGE_EXTS.includes(ext)) limit = STORAGE_LIMITS.photo
    if (file.size > limit) throw new Error('file_too_large')

    // Пустой type (браузер не отдал mime) — по MIME не блокируем, размер уже проверен.
    if (!type) return
    const allowed = type.startsWith('image/') || type === 'application/pdf' || FILE_OFFICE_MIME.includes(type)
    if (!allowed) throw new Error('file_type_not_allowed')
    return
  }

  if (file.size > STORAGE_LIMITS[kind]) throw new Error('file_too_large')
  // Пустой type — некоторые браузеры не отдают mime; лимит уже применён.
  if (!type) return
  if (!MIME_WHITELIST[kind].includes(type)) throw new Error('file_type_not_allowed')
}

// Если ошибка — это код валидации загрузки, вернуть его (экраны показывают через t()),
// иначе null → экран применит своё прежнее поведение (сеть/доступ).
export function uploadErrorCode(err: unknown): 'file_too_large' | 'file_type_not_allowed' | null {
  const m = err instanceof Error ? err.message : ''
  return m === 'file_too_large' || m === 'file_type_not_allowed' ? m : null
}

// iOS-паритет (Check Time media-extension.ts): фото/видео-пикеры iOS иногда отдают File
// с пустым или бесрасширенным именем (HEIC/MOV). Выводим настоящее расширение из MIME,
// чтобы storage_path нёс корректный суффикс. '' — если MIME неизвестен.
function extensionFromMime(mime: string): string {
  switch ((mime || '').toLowerCase()) {
    // image
    case 'image/jpeg': return 'jpg'
    case 'image/png': return 'png'
    case 'image/heic': return 'heic'
    case 'image/heif': return 'heif'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    // video
    case 'video/mp4': return 'mp4'
    case 'video/quicktime': return 'mov'
    case 'video/webm': return 'webm'
    case 'video/x-matroska': return 'mkv'
    case 'video/3gpp': return '3gp'
    // doc
    case 'application/pdf': return 'pdf'
    case 'application/msword': return 'doc'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx'
    case 'application/vnd.ms-excel': return 'xls'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx'
    case 'text/csv':
    case 'application/csv': return 'csv'
    case 'text/plain': return 'txt'
    default: return ''
  }
}

// Слугификация имени файла. Если имя пустое ИЛИ без пригодного расширения — дописываем
// расширение, выведенное из MIME (mime). Для имён с валидным расширением поведение
// прежнее (байт-в-байт). mime необязателен: без него поведение как раньше.
export function safeFileName(name: string, mime?: string) {
  const fallback = 'photo.jpg'
  const slugged = (name || '').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '')
  // Уже есть пригодное расширение → прежний результат без изменений.
  if (slugged && /\.[a-z0-9]{1,5}$/i.test(slugged)) return slugged
  const ext = extensionFromMime(mime ?? '')
  if (slugged) return ext ? `${slugged}.${ext}` : slugged
  return ext ? `photo.${ext}` : fallback
}

// Паритет Check Time (upload-limits.ts inferUploadContentType): часть браузеров отдаёт File
// с пустым type или общим 'application/octet-stream' (нередко для PDF, office-докам и
// .webm/.mov на ряде платформ). Прежний `file.type || 'image/jpeg'` в таком случае метил
// не-картинки как JPEG → ломался inline-preview и content-type скачивания для pdf/office/webm.
// Здесь выводим content-type из расширения имени. Неизвестное расширение → 'application/octet-stream'
// (НЕ image/jpeg). Только клиентский content-type для storage PUT — БД/insert-колонки не трогаем.
const EXT_CONTENT_TYPE: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  gif: 'image/gif',
}

export function inferUploadContentType(file: { name?: string | null; type?: string | null }): string {
  const type = (file.type || '').trim().toLowerCase()
  // Конкретный MIME от браузера — доверяем ему как есть.
  if (type && type !== 'application/octet-stream') return type
  // Пустой или общий octet-stream → выводим по расширению имени файла.
  const name = file.name || ''
  const ext = name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : ''
  return EXT_CONTENT_TYPE[ext] || 'application/octet-stream'
}

async function insertTaskMediaRow(p: Profile, task: Task, storagePath: string, file: File) {
  const { data, error } = await supabase.from('media').insert({
    org_id: p.org_id,
    project_id: task.project_id ?? null,
    task_id: task.id,
    uploaded_by: p.id,
    media_type: 'photo',
    category: 'task_photo',
    storage_path: storagePath,
    filename: safeFileName(file.name, file.type),
    mime: file.type || 'image/jpeg',
    size_bytes: file.size,
  }).select('id').single()
  if (error) throw error
  return String(data.id)
}

export async function uploadTaskPhoto(p: Profile, task: Task, file: File): Promise<TaskMedia> {
  validateUpload(file, 'photo')
  const ext = safeFileName(file.name, file.type).split('.').pop() || 'jpg'
  const storagePath = `tasks/${p.org_id}/${task.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, file, {
      contentType: inferUploadContentType(file),
      upsert: false,
    })

  if (uploadError) throw uploadError
  const mediaId = await insertTaskMediaRow(p, task, storagePath, file)
  return { id: mediaId, storage_path: storagePath, preview_url: URL.createObjectURL(file) }
}

const MEDIA_SIGN_TIMEOUT_MS = 9000

// Паритет Check Time (normalizeStoragePath): в легаси-строках storage_path иногда лежит с
// ведущим '/' или с префиксом bucket ('media/...'), из-за чего createSignedUrl падает с
// "Bucket not found"/404 — ключ должен быть относительным к bucket и без ведущего слэша.
// Для корректных путей (напр. 'videos/<org>/<id>.mp4') это чистый no-op.
function normalizeStoragePath(path: string): string {
  if (!path) return ''
  let key = path.replace(/^\/+/, '')
  if (key.startsWith(`${TASK_MEDIA_BUCKET}/`)) key = key.slice(TASK_MEDIA_BUCKET.length + 1)
  return key
}

// A5: bucket media — ПРИВАТНЫЙ. Раньше при ошибке/таймауте подписи возвращали getPublicUrl(),
// но на приватном bucket такой URL не аутентифицируется (404 / утечка пути объекта). Теперь при
// неудаче подписи возвращаем null — вызывающий рендерит «нет ссылки», а не битый <img>/<video>.
export async function mediaUrl(storagePath: string): Promise<string | null> {
  const key = normalizeStoragePath(storagePath)
  let timer: ReturnType<typeof setTimeout> | undefined
  const signPromise = supabase.storage.from(TASK_MEDIA_BUCKET).createSignedUrl(key, 3600)
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MEDIA_SIGN_TIMEOUT_MS)
  })
  try {
    const signed = await Promise.race([signPromise, timeoutPromise])
    if (signed && !signed.error && signed.data?.signedUrl) return signed.data.signedUrl
    if (signed && signed.error) warnReadError('mediaUrl', signed.error)
    else if (!signed) console.warn(`[api:mediaUrl] sign timeout after ${MEDIA_SIGN_TIMEOUT_MS}ms`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return null
}

export async function uploadCheckoutVideo(p: Profile, eventId: string, file: File) {
  validateUpload(file, 'video')
  // A5: неизменяемая улика — уникальный путь + upsert:false, чтобы второй upload НЕ перезаписал первый.
  // Авторитетный указатель хранится в time_events.video_path (читается из строки, не пересчитывается).
  const storagePath = `videos/${p.org_id}/${eventId}-${Date.now()}-${crypto.randomUUID()}.mp4`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, file, {
      contentType: inferUploadContentType(file),
      upsert: false,
    })
  if (uploadError) throw uploadError

  // time_events has NO client-side RLS UPDATE policy, so a direct .update() silently fails.
  // The SECURITY DEFINER RPC is the only legal write path: it sets BOTH video_path AND
  // video_status='uploaded' itself, write-once, and derives org/permission from auth context.
  const { error } = await supabase.rpc('attach_checkout_video', { p_event_id: eventId, p_video_path: storagePath })
  if (error) throw error
  await logEvent(p, 'time.checkout_video_uploaded', 'time_event', eventId, { video_path: storagePath })
  return storagePath
}

export async function uploadSafetySignature(p: Profile, projectId: string, eventId: string, signature: Blob) {
  // A5: неизменяемая улика — уникальный путь + upsert:false; авторитет — safety_acknowledgements.signature_path.
  const storagePath = `signatures/${p.org_id}/${eventId}-${Date.now()}-${crypto.randomUUID()}.png`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, signature, {
      contentType: 'image/png',
      upsert: false,
    })
  if (uploadError) throw uploadError

  const { error } = await supabase.from('safety_acknowledgements').insert({
    org_id: p.org_id,
    worker_id: p.id,
    project_id: projectId,
    time_event_id: eventId,
    signature_path: storagePath,
    doc_version: 'v1',
  })
  if (error) throw error
  await logEvent(p, 'safety.acknowledged', 'project', projectId, { time_event_id: eventId, signature_path: storagePath })
  return storagePath
}

// «Галерея»: все фото объектов (media_type='photo', не удалённые) с именем проекта.
// Подписанные URL берём пачкой, порядок — сначала свежие. Лимит держит галерею лёгкой.
// Размер страницы галереи по умолчанию — сохраняет прежний потолок в 200 для существующих вызовов.
export const GALLERY_PAGE_SIZE = 200

export async function getGalleryPhotos(offset = 0, limit = GALLERY_PAGE_SIZE): Promise<GalleryPhoto[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, filename, created_at, project_id, category, uploaded_by, project:projects(name), uploader:profiles!media_uploaded_by_fkey(name)')
    .eq('media_type', 'photo')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) { warnReadError('getGalleryPhotos', error); return [] }

  const photos = await Promise.all(((data ?? []) as unknown as Array<{
    id: string
    storage_path: string | null
    filename?: string | null
    created_at?: string | null
    project_id?: string | null
    category?: string | null
    uploaded_by?: string | null
    project?: { name: string | null } | null
    uploader?: { name: string | null } | null
  }>).map(async (row) => {
    if (!row.storage_path) return null
    const url = await mediaUrl(row.storage_path)
    if (!url) return null // A5: подпись не удалась → не показываем битое превью (приватный bucket)
    return {
      id: row.id,
      url,
      filename: row.filename ?? null,
      created_at: row.created_at ?? null,
      project_id: row.project_id ?? null,
      project_name: row.project?.name ?? null,
      category: row.category ?? null,
      uploaded_by: row.uploaded_by ?? null,
      uploader_name: row.uploader?.name ?? null,
    }
  }))

  return photos.filter((photo): photo is GalleryPhoto => photo !== null)
}

// «Галерея» → вкладка Видео: все видео объектов (media_type='video', не удалённые) с именем проекта.
// Строго по образцу getGalleryPhotos, только media_type='video'. Подписанные URL берём пачкой.
export async function getGalleryVideos(offset = 0, limit = GALLERY_PAGE_SIZE): Promise<GalleryVideo[]> {
  const { data, error } = await supabase.from('media')
    .select('id, storage_path, filename, created_at, project_id, category, uploaded_by, project:projects(name), uploader:profiles!media_uploaded_by_fkey(name)')
    .eq('media_type', 'video')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) { warnReadError('getGalleryVideos', error); return [] }

  const videos = await Promise.all(((data ?? []) as unknown as Array<{
    id: string
    storage_path: string | null
    filename?: string | null
    created_at?: string | null
    project_id?: string | null
    category?: string | null
    uploaded_by?: string | null
    project?: { name: string | null } | null
    uploader?: { name: string | null } | null
  }>).map(async (row) => {
    if (!row.storage_path) return null
    const url = await mediaUrl(row.storage_path)
    if (!url) return null // A5: подпись не удалась → не показываем битое превью (приватный bucket)
    return {
      id: row.id,
      url,
      filename: row.filename ?? null,
      created_at: row.created_at ?? null,
      project_id: row.project_id ?? null,
      project_name: row.project?.name ?? null,
      category: row.category ?? null,
      uploaded_by: row.uploaded_by ?? null,
      uploader_name: row.uploader?.name ?? null,
    }
  }))

  return videos.filter((video): video is GalleryVideo => video !== null)
}

// «Галерея» → вкладка PDF: PDF-документы из таблицы files (mime pdf, не удалённые) с именем проекта.
// URL не резолвим здесь (зависит от scope) — открываем по клику через getGalleryPdfUrl.
// RLS files сама ограничивает org и видимость (менеджер видит всё, приватные — владелец/менеджер).
export async function getGalleryPdfs(offset = 0, limit = GALLERY_PAGE_SIZE): Promise<GalleryPdf[]> {
  const { data, error } = await supabase.from('files')
    .select('id, name, storage_path, scope, created_at, project_id, uploaded_by, project:projects(name), uploader:profiles!files_uploaded_by_fkey(name)')
    .ilike('mime', 'application/pdf')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) { warnReadError('getGalleryPdfs', error); return [] }

  return ((data ?? []) as unknown as Array<{
    id: string
    name: string
    storage_path: string
    scope: string
    created_at?: string | null
    project_id?: string | null
    uploaded_by?: string | null
    project?: { name: string | null } | null
    uploader?: { name: string | null } | null
  }>).map((row) => ({
    id: row.id,
    name: row.name,
    storage_path: row.storage_path,
    scope: row.scope,
    created_at: row.created_at ?? null,
    project_id: row.project_id ?? null,
    project_name: row.project?.name ?? null,
    uploaded_by: row.uploaded_by ?? null,
    uploader_name: row.uploader?.name ?? null,
  }))
}

// Ссылка на PDF галереи: scope='project' — R2 (r2Sign download, как getProjectFileDownloadUrl),
// иначе — media bucket (mediaUrl, как экран «Файлы»). Переиспользуем имеющуюся логику скачивания.
export async function getGalleryPdfUrl(pdf: { scope: string; storage_path: string }): Promise<string | null> {
  if (pdf.scope === 'project') {
    const signed = await r2Sign('download', pdf.storage_path)
    return signed.url
  }
  return mediaUrl(pdf.storage_path)
}

// Открытые флаги «на проверку» (resolved_at IS NULL) — для бейджа на фото в галерее.
// RLS сам ограничивает org и видимость (свои флаги видит любой, все — менеджер).
export async function getOpenMediaFlags(): Promise<MediaFlag[]> {
  const { data, error } = await supabase.from('media_flags')
    .select('id, media_id, reason, flagged_by, created_at')
    .is('resolved_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data ?? []) as unknown as MediaFlag[]
}

// Поставить флаг «на проверку» на фото — доступно любому пользователю (RLS: flagged_by = auth.uid()).
export async function flagMedia(p: Profile, mediaId: string, reason: string): Promise<void> {
  const { error } = await supabase.from('media_flags').insert({
    org_id: p.org_id,
    media_id: mediaId,
    flagged_by: p.id,
    reason,
  })
  if (error) throw error
  await logEvent(p, 'media.flagged', 'media', mediaId, { reason })
}

// Снять флаг (проверено) — только менеджер (RLS: app.is_manager_write()).
export async function resolveMediaFlag(p: Profile, flagId: string): Promise<void> {
  const { data, error } = await supabase.from('media_flags')
    .update({ resolved_by: p.id, resolved_at: new Date().toISOString() })
    .eq('id', flagId)
    .select('media_id')
    .maybeSingle()
  if (error) throw error
  await logEvent(p, 'media.flag_resolved', 'media', (data as { media_id?: string } | null)?.media_id ?? null, {})
}

// Комментарии к медиа (media_comments): текст под фото, по возрастанию времени.
// Имя автора тянем embed-ом author:profiles(name) — FK author_id -> profiles единственный.
// RLS отдаёт комментарии, если строка media видна; на ошибке возвращаем [].
export async function getMediaComments(mediaId: string): Promise<MediaComment[]> {
  const { data, error } = await supabase.from('media_comments')
    .select('id, media_id, author_id, body, created_at, author:profiles(name)')
    .eq('media_id', mediaId)
    .order('created_at', { ascending: true })
  if (error) return []
  return (data as unknown as MediaComment[]) ?? []
}

// Добавить текстовый комментарий к медиа. RLS: author_id = auth.uid() (= profile.id),
// media_id должен указывать на существующую строку media. voice_path в v1 не пишем.
// Пустой текст игнорируем; возвращаем вставленную строку с именем автора для дозаписи в UI.
export async function addMediaComment(p: Profile, mediaId: string, body: string): Promise<MediaComment | null> {
  const text = body.trim()
  if (!text) return null
  const { data, error } = await supabase.from('media_comments')
    .insert({ media_id: mediaId, author_id: p.id, body: text })
    .select('id, media_id, author_id, body, created_at, author:profiles(name)')
    .single()
  if (error) throw error
  await logEvent(p, 'media.commented', 'media', mediaId, {})
  return (data as unknown as MediaComment) ?? null
}

export async function getArchivedMedia(): Promise<ArchivedMedia[]> {
  const { data, error } = await supabase.from('media')
    .select('id, filename, project_id, media_type, category, deleted_at, project:projects(name)')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
  if (error) return []
  return (data as unknown as ArchivedMedia[]) ?? []
}

// «Файлы и документы» (files): storage_path — в тот же bucket, что и медиа задач (TASK_MEDIA_BUCKET).
// RLS: SELECT org-скоуп + видимость (менеджер видит всё, приватные — владелец/менеджер); удалённые прячем.
export const FILE_SELECT = 'id, org_id, scope, project_id, profile_id, account_id, folder, name, storage_path, mime, size_bytes, doc_kind, expires_at, is_private, uploaded_by, created_at'

export async function getFiles(): Promise<FileRow[]> {
  const { data, error } = await supabase.from('files')
    .select(FILE_SELECT)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as FileRow[]) ?? []
}

// Загрузка файла: blob в bucket медиа + строка files. RLS INSERT требует org_id=app.org_id()
// и (менеджер ИЛИ uploaded_by=uid) — потому всегда пишем uploaded_by=p.id и org_id=p.org_id.
export async function uploadFile(p: Profile, input: {
  file: Blob
  name: string
  scope: string
  folder: string
  is_private: boolean
  doc_kind?: string | null
  expires_at?: string | null
  project_id?: string | null
  profile_id?: string | null
  account_id?: string | null
}): Promise<FileRow> {
  validateUpload({ size: input.file.size, type: input.file.type, name: input.name }, 'file')
  const safeName = safeFileName(input.name, input.file.type)
  const storagePath = `files/${p.org_id}/${crypto.randomUUID()}-${safeName}`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, input.file, {
      contentType: inferUploadContentType(input.file),
      upsert: false,
    })
  if (uploadError) throw uploadError

  const { data, error } = await supabase.from('files').insert({
    org_id: p.org_id,
    scope: input.scope,
    folder: input.folder,
    name: input.name,
    storage_path: storagePath,
    mime: input.file.type || null,
    size_bytes: input.file.size,
    doc_kind: input.doc_kind ?? null,
    expires_at: input.expires_at ?? null,
    is_private: input.is_private,
    uploaded_by: p.id,
    project_id: input.project_id ?? null,
    profile_id: input.profile_id ?? null,
    account_id: input.account_id ?? null,
  }).select(FILE_SELECT).single()
  if (error) throw error
  await logEvent(p, 'file.uploaded', 'file', data.id, { name: input.name })
  return data as unknown as FileRow
}

// Мягкое удаление файла: deleted_at = now(). RLS UPDATE — менеджер ИЛИ владелец.
export async function softDeleteFile(p: Profile, id: string): Promise<void> {
  const { error } = await supabase.from('files')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
  await logEvent(p, 'file.deleted', 'file', id, {})
}

// === R2 (Cloudflare) файлы проекта — метаданные в files, содержимое в R2 через edge-функцию r2-sign. ===
// Файлы одного проекта (scope='project'): те же поля, что getFiles, но со скоупом project_id.
export async function getProjectFiles(projectId: string): Promise<FileRow[]> {
  const { data, error } = await supabase.from('files')
    .select(FILE_SELECT)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as FileRow[]) ?? []
}

// Файлы проекта с именем автора загрузки — для вкладки «Файлы и медиа» хаба.
// Как getProjectFiles, но embed-ом тянем uploader:profiles(name) (единственный FK files.uploaded_by,
// тот же, что в getGalleryPdfs). Только чтение; RLS files держит org-скоуп и приватность.
export async function getProjectHubFiles(projectId: string): Promise<ProjectHubFile[]> {
  const { data, error } = await supabase.from('files')
    .select(`${FILE_SELECT}, uploader:profiles!files_uploaded_by_fkey(name)`)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) { warnReadError('getProjectHubFiles', error); return [] }
  return ((data ?? []) as unknown as Array<FileRow & { uploader?: { name: string | null } | null }>)
    .map(({ uploader, ...row }) => ({ ...(row as FileRow), uploader_name: uploader?.name ?? null }))
}

// Подписанный запрос к edge-функции r2-sign: возвращает { url, method, key, expires_in }.
// Сервер сам добавляет org_id к ключу — возвращённый key и есть storage_path.
async function r2Sign(op: 'upload' | 'download', key: string): Promise<{ url: string; method: string; key: string; expires_in: number }> {
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) throw new Error('no session')
  const res = await fetch(`${SUPABASE_URL}/functions/v1/r2-sign`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ op, key }),
  })
  if (!res.ok) throw new Error(`r2-sign ${op} failed: ${res.status}`)
  return res.json()
}

// Загрузка произвольного файла проекта в R2: подпись → PUT в R2 → строка files.
// RLS INSERT: org_id=app.org_id() и (менеджер ИЛИ uploaded_by=uid) — потому org_id=p.org_id, uploaded_by=p.id.
export async function uploadProjectFileToR2(p: Profile, projectId: string, file: File): Promise<FileRow> {
  validateUpload(file, 'file')
  const key = `files/${crypto.randomUUID()}-${safeFileName(file.name, file.type)}`
  const signed = await r2Sign('upload', key)
  const putRes = await fetch(signed.url, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': inferUploadContentType(file) },
  })
  if (!putRes.ok) throw new Error(`R2 upload failed: ${putRes.status}`)

  const { data, error } = await supabase.from('files').insert({
    org_id: p.org_id,
    scope: 'project',
    project_id: projectId,
    folder: '',
    name: file.name,
    storage_path: signed.key,
    mime: file.type || null,
    size_bytes: file.size,
    doc_kind: null,
    expires_at: null,
    is_private: false,
    uploaded_by: p.id,
    profile_id: null,
    account_id: null,
  }).select(FILE_SELECT).single()
  if (error) throw error
  await logEvent(p, 'file.uploaded', 'file', data.id, { project_id: projectId })
  return data as unknown as FileRow
}

// Подписанная ссылка на скачивание/просмотр файла из R2 (действует 1 час) — открывать в новой вкладке.
export async function getProjectFileDownloadUrl(file: FileRow): Promise<string> {
  const signed = await r2Sign('download', file.storage_path)
  return signed.url
}

// === FILE-1: вложения смет/счётов (files.document_id) — содержимое в приватном media bucket. ===
// Вложение документа: тонкая проекция строки files, привязанной к смете/счёту через document_id.
// Отдельный тип (не FileRow) — document_id живёт вне FILE_SELECT/FileRow; здесь берём только нужное.
export interface DocumentFileRow {
  id: string
  name: string
  storage_path: string
  mime: string | null
  size_bytes: number | null
  uploaded_by: string | null
  created_at: string
}

const DOCUMENT_FILE_SELECT = 'id, name, storage_path, mime, size_bytes, uploaded_by, created_at'

// Список вложений документа (сметы/счёта): files.document_id = documentId, не удалённые, свежие сверху.
// RLS files держит org-скоуп и приватность (is_private=true → владелец/менеджер); на ошибке — [].
export async function getDocumentFiles(documentId: string): Promise<DocumentFileRow[]> {
  const { data, error } = await supabase.from('files')
    .select(DOCUMENT_FILE_SELECT)
    .eq('document_id', documentId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) { warnReadError('getDocumentFiles', error); return [] }
  return (data as unknown as DocumentFileRow[]) ?? []
}

// Подписанная ссылка на скачивание вложения из приватного media bucket (переиспользуем mediaUrl).
export async function getDocumentFileUrl(storagePath: string): Promise<string | null> {
  return mediaUrl(storagePath)
}

// Загрузка вложения сметы/счёта: blob → приватный media bucket по неизменяемому пути
// documents/<document_id>/<uuid>-<filename> (upsert:false), затем строка files с document_id.
// scope: 'project' если у документа есть project_id, иначе 'company'. account_id наследуем от документа.
// Заданы все NOT-NULL колонки без БД-дефолта (org_id/scope/folder/name/storage_path/is_private);
// metadata/version/created_at заполняет БД своими дефолтами (как в uploadFile). RLS INSERT:
// org_id=app.org_id() и (менеджер ИЛИ uploaded_by=uid) — потому org_id=p.org_id, uploaded_by=p.id.
export async function uploadDocumentFile(
  p: Profile,
  doc: { id: string; project_id: string | null; account_id: string | null },
  file: File,
): Promise<DocumentFileRow> {
  validateUpload(file, 'file')
  const safeName = safeFileName(file.name, file.type)
  const storagePath = `documents/${doc.id}/${crypto.randomUUID()}-${safeName}`
  const { error: uploadError } = await supabase.storage
    .from(TASK_MEDIA_BUCKET)
    .upload(storagePath, file, {
      contentType: inferUploadContentType(file),
      upsert: false,
    })
  if (uploadError) throw uploadError

  const { data, error } = await supabase.from('files').insert({
    org_id: p.org_id,
    document_id: doc.id,
    scope: doc.project_id ? 'project' : 'company',
    project_id: doc.project_id ?? null,
    account_id: doc.account_id ?? null,
    folder: '',
    name: file.name,
    storage_path: storagePath,
    mime: file.type || null,
    size_bytes: file.size,
    is_private: true,
    uploaded_by: p.id,
  }).select(DOCUMENT_FILE_SELECT).single()
  if (error) throw error
  await logEvent(p, 'file.uploaded', 'file', data.id, { document_id: doc.id, name: file.name })
  return data as unknown as DocumentFileRow
}

// Детач вложения от документа (мягко): files.document_id = null. Строка files и storage-объект
// остаются (bucket неизменяемый по политике) — просто снимаем привязку к смете/счёту.
// RLS UPDATE files: менеджер ИЛИ владелец загрузки; в UI показываем действие только менеджеру+.
export async function detachDocumentFile(p: Profile, id: string): Promise<void> {
  const { error } = await supabase.from('files')
    .update({ document_id: null })
    .eq('id', id)
  if (error) throw error
  await logEvent(p, 'file.detached', 'file', id, {})
}
