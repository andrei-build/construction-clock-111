import { supabase } from '../supabase'
import { logEvent } from './_shared'
import type { Profile, Project, ProjectProfit, ProjectPhoto, GalleryPhoto, TimeEvent, ProjectTimeEvent, WorkInterval, Task, TaskMedia, EventRow, TimelineEventRow, TimeEventType, ProfileRate, PayPeriod, MessageRow, ProjectAssignment, ScheduleAssignment, ProjectExclusion, CalendarEvent, Deal, DealStage, ReportKind, ReportRow, Role, SuspiciousShift, WorkerConsentRow, SafetyAckRow, AppSettings, LiveLastLocation, ShiftGeoEvent, ArchiveTable, ArchivedProject, ArchivedTask, ArchivedMedia, ArchiveProjectSummary, ArchivePayItem, ArchivePayPeriod, YearlyPayReportRow, DeactivatedWorker, TrashItem, SupplyStore, StoreVisit, UserCapability, DailyReport, MediaFlag, MediaComment, Account, AccountInput, ClientDifficulty, Contact, ContactInput, ClientGrant, ClientProjectSummary, DocumentProjectOption, DocumentRow, DocumentItem, ProjectExpense, Unit, FileRow, ProjectHubFile, ProjectNote, ProjectMaterial, MaterialSpecStatus, AccountRating, GalleryVideo, GalleryPdf, ProjectHubData, TaskAttachment } from '../types'


const DOCUMENT_SELECT = 'id, org_id, account_id, project_id, doc_type, status, number, title, source_document_id, issue_date, due_date, subtotal, tax_rate, tax_amount, total, amount_paid, balance, retainage_pct, margin_pct, client_visible, notes, metadata, created_by, updated_by, version, created_at, updated_at, deleted_at, account:accounts(name), project:projects(name)'

export interface DocumentLineInput {
  description: string
  qty: number
  unit_id: string | null
  unit_price: number
  markup_pct: number
  total: number
}

export async function getDocumentAccounts(): Promise<Account[]> {
  const { data, error } = await supabase.from('accounts')
    .select('id, org_id, name')
    .order('name')
  if (error) return []
  return (data as Account[]) ?? []
}

export async function getDocumentProjects(): Promise<DocumentProjectOption[]> {
  const { data, error } = await supabase.from('projects')
    .select('id, name, client_account_id')
    .order('name')
  if (error) return []
  return (data as DocumentProjectOption[]) ?? []
}

export async function getDocumentUnits(): Promise<Unit[]> {
  const { data, error } = await supabase.from('units')
    .select('id, org_id, name, abbreviation')
    .order('name')
  if (error) return []
  return (data as Unit[]) ?? []
}

export async function getDocuments(): Promise<DocumentRow[]> {
  const { data, error } = await supabase.from('documents')
    .select(DOCUMENT_SELECT)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as unknown as DocumentRow[]) ?? []
}

// Документы одного проекта — вкладка «Финансы» в Project Hub (RLS скоупит финансовую видимость)
export async function getProjectDocuments(projectId: string): Promise<DocumentRow[]> {
  const { data, error } = await supabase.from('documents')
    .select(DOCUMENT_SELECT).eq('project_id', projectId).is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as unknown as DocumentRow[]) ?? []
}

// Расходы одного проекта — вкладка «Финансы» в Project Hub (RLS скоупит финансовую видимость; удалённые прячем)
const PROJECT_EXPENSE_SELECT = 'id, org_id, project_id, kind, description, amount, vendor, source, incurred_at, created_by, created_at, deleted_at'

export async function getProjectExpenses(projectId: string): Promise<ProjectExpense[]> {
  const { data, error } = await supabase.from('project_expenses')
    .select(PROJECT_EXPENSE_SELECT).eq('project_id', projectId).is('deleted_at', null)
    .order('incurred_at', { ascending: false, nullsFirst: false })
  if (error) return []
  return (data as ProjectExpense[]) ?? []
}

// NAV-2: лёгкая сумма расходов на материалы по всей орге — тайл «Материалы $» на «Обзоре»
// (finance-gated в UI). Один запрос; RLS скоупит финансовую видимость, при отказе → 0. kind
// свободный, поэтому материалы ловим по подстроке; нет совпадений → 0 (расходов ещё нет).
export async function getMaterialsSpendTotal(): Promise<number> {
  const { data, error } = await supabase.from('project_expenses')
    .select('kind, amount').is('deleted_at', null)
  if (error || !data) return 0
  return (data as { kind: string | null; amount: number | null }[]).reduce((acc, row) => {
    const kind = (row.kind ?? '').toLowerCase()
    const isMaterial = kind.includes('material') || kind.includes('материал')
    return isMaterial ? acc + (Number(row.amount) || 0) : acc
  }, 0)
}

export async function getDocumentItems(documentId: string): Promise<DocumentItem[]> {
  const { data, error } = await supabase.from('document_items')
    .select('id, document_id, cost_code_id, description, qty, unit_id, unit_price, markup_pct, is_client_material, total, sort_order, metadata, unit:units(abbreviation, name), cost_code:cost_codes(code, name)')
    .eq('document_id', documentId)
    .order('sort_order')
  if (error) return []
  return (data as unknown as DocumentItem[]) ?? []
}

function documentItemRows(documentId: string, items: DocumentLineInput[]) {
  return items.map((item, index) => ({
    document_id: documentId,
    description: item.description,
    qty: item.qty,
    unit_id: item.unit_id,
    unit_price: item.unit_price,
    markup_pct: item.markup_pct,
    is_client_material: false,
    total: item.total,
    sort_order: index + 1,
  }))
}

function numeric(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export async function createEstimateDocument(p: Profile, input: {
  number: string
  title: string
  accountId: string
  projectId: string | null
  issueDate: string
  taxRate: number
  notes: string | null
  subtotal: number
  taxAmount: number
  total: number
  items: DocumentLineInput[]
}): Promise<string> {
  const { data, error } = await supabase.from('documents')
    .insert({
      org_id: p.org_id,
      account_id: input.accountId,
      project_id: input.projectId,
      doc_type: 'estimate',
      status: 'draft',
      number: input.number,
      title: input.title,
      issue_date: input.issueDate,
      subtotal: input.subtotal,
      tax_rate: input.taxRate,
      tax_amount: input.taxAmount,
      total: input.total,
      amount_paid: 0,
      balance: input.total,
      notes: input.notes,
      created_by: p.id,
    })
    .select('id')
    .single()
  if (error) throw error

  const documentId = String(data.id)
  if (input.items.length > 0) {
    const { error: itemError } = await supabase.from('document_items')
      .insert(documentItemRows(documentId, input.items))
      .select('id')
    if (itemError) throw itemError
  }

  await logEvent(p, 'document.created', 'document', documentId, { doc_type: 'estimate', total: input.total })
  return documentId
}

export async function convertEstimateToInvoice(p: Profile, estimate: DocumentRow, items: DocumentItem[], input: {
  number: string
  issueDate: string
  dueDate: string
}): Promise<string> {
  const { data, error } = await supabase.from('documents')
    .insert({
      org_id: p.org_id,
      account_id: estimate.account_id,
      project_id: estimate.project_id,
      doc_type: 'invoice',
      status: 'draft',
      number: input.number,
      title: estimate.title,
      source_document_id: estimate.id,
      issue_date: input.issueDate,
      due_date: input.dueDate,
      subtotal: numeric(estimate.subtotal),
      tax_rate: numeric(estimate.tax_rate),
      tax_amount: numeric(estimate.tax_amount),
      total: numeric(estimate.total),
      amount_paid: 0,
      balance: numeric(estimate.total),
      notes: estimate.notes,
      created_by: p.id,
    })
    .select('id')
    .single()
  if (error) throw error

  const invoiceId = String(data.id)
  if (items.length > 0) {
    const rows = items.map((item, index) => ({
      document_id: invoiceId,
      cost_code_id: item.cost_code_id,
      description: item.description,
      qty: numeric(item.qty),
      unit_id: item.unit_id,
      unit_price: numeric(item.unit_price),
      markup_pct: numeric(item.markup_pct),
      is_client_material: Boolean(item.is_client_material),
      total: numeric(item.total),
      sort_order: item.sort_order ?? index + 1,
      metadata: item.metadata,
    }))
    const { error: itemError } = await supabase.from('document_items')
      .insert(rows)
      .select('id')
    if (itemError) throw itemError
  }

  await logEvent(p, 'document.invoiced', 'document', invoiceId, {
    source_document_id: estimate.id,
    total: numeric(estimate.total),
  })
  return invoiceId
}

export async function markDocumentPaid(p: Profile, invoice: DocumentRow): Promise<void> {
  const total = numeric(invoice.total)
  const { error } = await supabase.from('documents')
    .update({
      status: 'paid',
      amount_paid: total,
      balance: 0,
      updated_by: p.id,
    })
    .eq('id', invoice.id)
    .select('id')
    .single()
  if (error) throw error
  await logEvent(p, 'document.paid', 'document', invoice.id, { total })
}

const ACCOUNT_SELECT = 'id, org_id, name, account_type, email, phone, address, notes, is_taxable, insurance_status, client_rating, rating_note, rating, difficulty, metadata, created_by, updated_by, version, created_at, updated_at, deleted_at, archived_at'
const CONTACT_SELECT = 'id, org_id, account_id, name, title, email, phone, is_primary, notes, created_at, updated_at, deleted_at'
const CLIENT_PROJECT_SELECT = 'id, name, status, client_account_id'
const CLIENT_DOCUMENT_SELECT = 'id, org_id, account_id, project_id, doc_type, status, number, title, total, balance, issue_date'

export async function getClientAccounts(): Promise<Account[]> {
  const { data, error } = await supabase.from('accounts')
    .select(ACCOUNT_SELECT)
    .is('deleted_at', null)
    .order('name')
  if (error) return []
  return (data as Account[]) ?? []
}

export async function createAccount(p: Profile, input: AccountInput): Promise<Account> {
  const { data, error } = await supabase.from('accounts')
    .insert({ org_id: p.org_id, created_by: p.id, ...input })
    .select(ACCOUNT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'account.created', 'account', data.id, {})
  return data as Account
}

export async function updateAccount(p: Profile, accountId: string, input: AccountInput): Promise<Account> {
  const { data, error } = await supabase.from('accounts')
    .update({ ...input, updated_by: p.id })
    .eq('id', accountId)
    .select(ACCOUNT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'account.updated', 'account', accountId, {})
  return data as Account
}

// CLI-1: обновить внутреннюю оценку клиента — рейтинг 1..5 звёзд + сложность работы.
// Пишем только rating/difficulty (не трогаем прочие поля аккаунта). null очищает значение.
// RLS «is_manager_write» пускает только owner/admin/manager — не-менеджеру придёт ошибка.
export async function updateClientRating(
  p: Profile,
  accountId: string,
  input: { rating: number | null; difficulty: ClientDifficulty | null },
): Promise<Account> {
  const { data, error } = await supabase.from('accounts')
    .update({ rating: input.rating, difficulty: input.difficulty, updated_by: p.id })
    .eq('id', accountId)
    .select(ACCOUNT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'account.rating_updated', 'account', accountId, { rating: input.rating, difficulty: input.difficulty })
  return data as Account
}

export async function getAccountContacts(accountId: string): Promise<Contact[]> {
  const { data, error } = await supabase.from('contacts')
    .select(CONTACT_SELECT)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('is_primary', { ascending: false })
    .order('name')
  if (error) return []
  return (data as Contact[]) ?? []
}

export async function createContact(p: Profile, accountId: string, input: ContactInput): Promise<Contact> {
  const { data, error } = await supabase.from('contacts')
    .insert({ org_id: p.org_id, account_id: accountId, ...input })
    .select(CONTACT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'contact.created', 'contact', data.id, { account_id: accountId })
  return data as Contact
}

export async function getClientProjectSummaries(accountId?: string): Promise<ClientProjectSummary[]> {
  let query = supabase.from('projects')
    .select(CLIENT_PROJECT_SELECT)
    .is('deleted_at', null)
  query = accountId ? query.eq('client_account_id', accountId) : query.not('client_account_id', 'is', null)
  const { data, error } = await query.order('name')
  if (error) return []
  return (data as ClientProjectSummary[]) ?? []
}

export async function getClientDeals(accountId: string): Promise<Deal[]> {
  const { data, error } = await supabase.from('deals')
    .select('id, org_id, account_id, contact_id, title, stage, expected_amount, next_action, next_action_at')
    .eq('account_id', accountId)
    .order('next_action_at', { ascending: true, nullsFirst: false })
  if (error) return []
  return (data as Deal[]) ?? []
}

export async function getClientDocuments(accountId: string): Promise<DocumentRow[]> {
  const { data, error } = await supabase.from('documents')
    .select(CLIENT_DOCUMENT_SELECT)
    .eq('account_id', accountId)
    .is('deleted_at', null)
    .order('issue_date', { ascending: false, nullsFirst: false })
  if (error) return []
  return (data as DocumentRow[]) ?? []
}

export async function getDeals(): Promise<Deal[]> {
  const { data, error } = await supabase.from('deals')
    .select('id, org_id, title, stage, expected_amount, next_action')
    .order('expected_amount', { ascending: false })
  if (error) return []
  return (data as Deal[]) ?? []
}

export async function updateDealStage(p: Profile, deal: Deal, stage: DealStage) {
  const { error } = await supabase.from('deals')
    .update({ stage })
    .eq('id', deal.id)
  if (error) throw error
  await logEvent(p, 'sales.stage_changed', 'deal', deal.id, { from: deal.stage, to: stage, title: deal.title })
}

// ---- Вкладка «Клиент» Хаба: гранты видимости присутствия (client_visibility_grants) ----
const CLIENT_GRANT_SELECT = 'id, org_id, account_id, project_id, can_see_presence, notify_travel, notify_checkin, notify_checkout, channel, note, created_by, created_at, revoked_at'

// Один аккаунт по id (имя/контакты клиента). RLS держит org-скоуп. error→null.
export async function getAccountById(accountId: string): Promise<Account | null> {
  const { data, error } = await supabase.from('accounts')
    .select(ACCOUNT_SELECT)
    .eq('id', accountId)
    .maybeSingle()
  if (error) return null
  return (data as Account | null) ?? null
}

// Активные гранты проекта (revoked_at IS NULL), новейшие сверху. error→[].
export async function getProjectGrants(projectId: string): Promise<ClientGrant[]> {
  const { data, error } = await supabase.from('client_visibility_grants')
    .select(CLIENT_GRANT_SELECT)
    .eq('project_id', projectId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
  if (error) return []
  return (data as ClientGrant[]) ?? []
}

// Создать грант. org_id=p.org_id и created_by=p.id удовлетворяют RLS check (is_manager_write через роль).
export async function createProjectGrant(
  p: Profile,
  projectId: string,
  accountId: string,
  input: { can_see_presence: boolean; notify_travel: boolean; notify_checkin: boolean; notify_checkout: boolean; channel?: string; note?: string | null },
): Promise<ClientGrant> {
  const { data, error } = await supabase.from('client_visibility_grants')
    .insert({
      org_id: p.org_id,
      account_id: accountId,
      project_id: projectId,
      created_by: p.id,
      channel: input.channel ?? 'portal',
      note: input.note ?? null,
      can_see_presence: input.can_see_presence,
      notify_travel: input.notify_travel,
      notify_checkin: input.notify_checkin,
      notify_checkout: input.notify_checkout,
    })
    .select(CLIENT_GRANT_SELECT)
    .single()
  if (error) throw error
  await logEvent(p, 'grant.created', 'client_visibility_grant', data.id, { project_id: projectId, account_id: accountId })
  return data as ClientGrant
}

// Отозвать грант: UPDATE revoked_at = now() (единственный способ убрать — DELETE-политики нет).
export async function revokeProjectGrant(p: Profile, grantId: string): Promise<void> {
  const { error } = await supabase.from('client_visibility_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', grantId)
  if (error) throw error
  await logEvent(p, 'grant.revoked', 'client_visibility_grant', grantId, {})
}
