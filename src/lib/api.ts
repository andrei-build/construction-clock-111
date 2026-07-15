// REFAC-1: src/lib/api.ts is now a thin re-export shim. The implementation lives in
// per-domain modules under src/lib/api/. Every symbol that used to be exported from this
// file is re-exported below, so existing `import { X } from '.../lib/api'` keeps working.
// RULE FOR THE FUTURE: add new api functions to the relevant domain module in src/lib/api/,
// NOT back into this shim.
export * from './api/_shared'
export * from './api/storage'
export * from './api/projects'
export * from './api/tasks'
export * from './api/team'
export * from './api/payroll'
export * from './api/materials'
export * from './api/geo'
export * from './api/calendar'
export * from './api/messages'
export * from './api/clients'

// OFFLINE-1 (pass 1a): read-through IndexedDB cache. We wrap the domain READ functions here in
// the shim so the domain modules stay byte-for-byte unchanged (their logic is not rewritten) and
// screens keep importing from '../lib/api'. Each explicit `export const` below shadows the same
// name coming from the matching `export *` above (an explicit export takes precedence over a
// wildcard re-export), swapping in the cached variant. withReadCache snapshots every successful
// read to IndexedDB and, while offline, serves the last snapshot + raises the offline banner.
// Finance-tagged reads ({ finance: true }) are only cached for roles that pass hasFinanceAccess.
// Reads that return short-lived signed media URLs are intentionally NOT wrapped (a cached URL
// would be expired offline); writes/subscriptions/mutations are never wrapped.
import { withReadCache } from './offlineReadCache'
import * as sharedApi from './api/_shared'
import * as projectsApi from './api/projects'
import * as tasksApi from './api/tasks'
import * as teamApi from './api/team'
import * as payrollApi from './api/payroll'
import * as materialsApi from './api/materials'
import * as geoApi from './api/geo'
import * as calendarApi from './api/calendar'
import * as messagesApi from './api/messages'
import * as clientsApi from './api/clients'

const FIN = { finance: true } as const

// _shared
export const getRecentActivity = withReadCache('getRecentActivity', sharedApi.getRecentActivity)
export const getRecentActivityForActor = withReadCache('getRecentActivityForActor', sharedApi.getRecentActivityForActor)
export const getTimelineEvents = withReadCache('getTimelineEvents', sharedApi.getTimelineEvents)
export const getTrashItems = withReadCache('getTrashItems', sharedApi.getTrashItems)
export const getAppSettings = withReadCache('getAppSettings', sharedApi.getAppSettings)

// projects
export const getProjects = withReadCache('getProjects', projectsApi.getProjects)
export const getBoardProjects = withReadCache('getBoardProjects', projectsApi.getBoardProjects)
export const getMapProjects = withReadCache('getMapProjects', projectsApi.getMapProjects)
export const getProjectProfit = withReadCache('getProjectProfit', projectsApi.getProjectProfit, FIN)
export const getProjectAssignments = withReadCache('getProjectAssignments', projectsApi.getProjectAssignments)
export const getProjectCrewCounts = withReadCache('getProjectCrewCounts', projectsApi.getProjectCrewCounts)
export const getProjectWeekHours = withReadCache('getProjectWeekHours', projectsApi.getProjectWeekHours)
export const getScheduleAssignments = withReadCache('getScheduleAssignments', projectsApi.getScheduleAssignments)
export const getProjectExclusions = withReadCache('getProjectExclusions', projectsApi.getProjectExclusions)
export const getArchivedProjects = withReadCache('getArchivedProjects', projectsApi.getArchivedProjects)
export const getArchiveProjectsSummary = withReadCache('getArchiveProjectsSummary', projectsApi.getArchiveProjectsSummary)
export const getDailyReports = withReadCache('getDailyReports', projectsApi.getDailyReports)
export const getProjectDailyReports = withReadCache('getProjectDailyReports', projectsApi.getProjectDailyReports)
export const getProjectById = withReadCache('getProjectById', projectsApi.getProjectById)
// getProjectHub bundles a finance-only `profit` slice, but RLS returns profit=null for
// non-finance roles, so a non-finance snapshot carries no finance data — safe to cache for all.
export const getProjectHub = withReadCache('getProjectHub', projectsApi.getProjectHub)
export const getAccountRating = withReadCache('getAccountRating', projectsApi.getAccountRating)
export const getProjectClientRatings = withReadCache('getProjectClientRatings', projectsApi.getProjectClientRatings)
export const getProjectNotes = withReadCache('getProjectNotes', projectsApi.getProjectNotes)
export const getProjectsNotesPreview = withReadCache('getProjectsNotesPreview', projectsApi.getProjectsNotesPreview)

// tasks
export const getOpenTasks = withReadCache('getOpenTasks', tasksApi.getOpenTasks)
export const getAllTasks = withReadCache('getAllTasks', tasksApi.getAllTasks)
export const getDonePhotoTasks = withReadCache('getDonePhotoTasks', tasksApi.getDonePhotoTasks)
export const getTaskPhotoIds = withReadCache('getTaskPhotoIds', tasksApi.getTaskPhotoIds)
export const getTaskAttachments = withReadCache('getTaskAttachments', tasksApi.getTaskAttachments)
export const getArchivedTasks = withReadCache('getArchivedTasks', tasksApi.getArchivedTasks)

// team / time
export const getTodayEvents = withReadCache('getTodayEvents', teamApi.getTodayEvents)
export const getEventsSince = withReadCache('getEventsSince', teamApi.getEventsSince)
export const getTimeEventsRange = withReadCache('getTimeEventsRange', teamApi.getTimeEventsRange)
export const getWorkerIntervals = withReadCache('getWorkerIntervals', teamApi.getWorkerIntervals)
export const getIntervalsBetween = withReadCache('getIntervalsBetween', teamApi.getIntervalsBetween)
export const getProjectIntervals = withReadCache('getProjectIntervals', teamApi.getProjectIntervals)
export const getProjectTimeEvents = withReadCache('getProjectTimeEvents', teamApi.getProjectTimeEvents)
export const getProjectShiftEvents = withReadCache('getProjectShiftEvents', teamApi.getProjectShiftEvents)
export const getTeam = withReadCache('getTeam', teamApi.getTeam)
export const getWorkerProfile = withReadCache('getWorkerProfile', teamApi.getWorkerProfile)
export const getWorkerTimeEvents = withReadCache('getWorkerTimeEvents', teamApi.getWorkerTimeEvents)
export const getWorkerPinAccess = withReadCache('getWorkerPinAccess', teamApi.getWorkerPinAccess)
export const getConsentWorkers = withReadCache('getConsentWorkers', teamApi.getConsentWorkers)
export const getActiveWorkerConsents = withReadCache('getActiveWorkerConsents', teamApi.getActiveWorkerConsents)
export const getSafetyAcknowledgements = withReadCache('getSafetyAcknowledgements', teamApi.getSafetyAcknowledgements)
export const getActiveLocationConsent = withReadCache('getActiveLocationConsent', teamApi.getActiveLocationConsent)
export const getSuspiciousShifts = withReadCache('getSuspiciousShifts', teamApi.getSuspiciousShifts)
export const getDeactivatedWorkers = withReadCache('getDeactivatedWorkers', teamApi.getDeactivatedWorkers)
export const getUserCapabilities = withReadCache('getUserCapabilities', teamApi.getUserCapabilities)
export const getWorkerDayClosedTasks = withReadCache('getWorkerDayClosedTasks', teamApi.getWorkerDayClosedTasks)
export const getWorkerDayTimeEvents = withReadCache('getWorkerDayTimeEvents', teamApi.getWorkerDayTimeEvents)

// payroll — finance (rates / pay periods / payroll & report rows)
export const getVisibleProfileRates = withReadCache('getVisibleProfileRates', payrollApi.getVisibleProfileRates, FIN)
export const getCurrentPayPeriod = withReadCache('getCurrentPayPeriod', payrollApi.getCurrentPayPeriod, FIN)
export const getPayPeriodByExactDates = withReadCache('getPayPeriodByExactDates', payrollApi.getPayPeriodByExactDates, FIN)
export const getYearlyPayrollReport = withReadCache('getYearlyPayrollReport', payrollApi.getYearlyPayrollReport, FIN)
export const getReportRows = withReadCache('getReportRows', payrollApi.getReportRows, FIN)
export const getArchivePayPeriods = withReadCache('getArchivePayPeriods', payrollApi.getArchivePayPeriods, FIN)

// materials
export const getProjectMaterials = withReadCache('getProjectMaterials', materialsApi.getProjectMaterials)
export const getProjectMaterialTasks = withReadCache('getProjectMaterialTasks', materialsApi.getProjectMaterialTasks)

// geo
export const getWorkerLastLocations = withReadCache('getWorkerLastLocations', geoApi.getWorkerLastLocations)
export const getLiveLastLocations = withReadCache('getLiveLastLocations', geoApi.getLiveLastLocations)
export const getOpenGeoEvents = withReadCache('getOpenGeoEvents', geoApi.getOpenGeoEvents)
export const getSupplyStores = withReadCache('getSupplyStores', geoApi.getSupplyStores)
export const getStoreVisits = withReadCache('getStoreVisits', geoApi.getStoreVisits)

// calendar
export const getCalendarEvents = withReadCache('getCalendarEvents', calendarApi.getCalendarEvents)
export const getProjectCalendarEvents = withReadCache('getProjectCalendarEvents', calendarApi.getProjectCalendarEvents)
export const getTeamCalendarEvents = withReadCache('getTeamCalendarEvents', calendarApi.getTeamCalendarEvents)

// messages
export const getMessages = withReadCache('getMessages', messagesApi.getMessages)
export const getRecentDispatchPlanSends = withReadCache('getRecentDispatchPlanSends', messagesApi.getRecentDispatchPlanSends)

// clients / sales / documents — money-bearing reads finance-gated
export const getDocumentAccounts = withReadCache('getDocumentAccounts', clientsApi.getDocumentAccounts)
export const getDocumentProjects = withReadCache('getDocumentProjects', clientsApi.getDocumentProjects)
export const getDocumentUnits = withReadCache('getDocumentUnits', clientsApi.getDocumentUnits)
export const getDocuments = withReadCache('getDocuments', clientsApi.getDocuments, FIN)
export const getProjectDocuments = withReadCache('getProjectDocuments', clientsApi.getProjectDocuments, FIN)
export const getProjectExpenses = withReadCache('getProjectExpenses', clientsApi.getProjectExpenses, FIN)
export const getMaterialsSpendTotal = withReadCache('getMaterialsSpendTotal', clientsApi.getMaterialsSpendTotal, FIN)
export const getDocumentItems = withReadCache('getDocumentItems', clientsApi.getDocumentItems, FIN)
export const getClientAccounts = withReadCache('getClientAccounts', clientsApi.getClientAccounts)
export const getAccountContacts = withReadCache('getAccountContacts', clientsApi.getAccountContacts)
export const getClientProjectSummaries = withReadCache('getClientProjectSummaries', clientsApi.getClientProjectSummaries)
export const getClientDeals = withReadCache('getClientDeals', clientsApi.getClientDeals, FIN)
export const getClientDocuments = withReadCache('getClientDocuments', clientsApi.getClientDocuments, FIN)
export const getDeals = withReadCache('getDeals', clientsApi.getDeals, FIN)
export const getAccountById = withReadCache('getAccountById', clientsApi.getAccountById)
export const getProjectGrants = withReadCache('getProjectGrants', clientsApi.getProjectGrants)

// OFFLINE-1 (pass 1b remainder): offline-aware WRITE wrappers. Same shim technique as the reads
// above — the domain writer (tasksApi.*/projectsApi.*) stays byte-for-byte unchanged; each const
// below shadows the wildcard re-export with a variant that, when the network is unreachable,
// durably ENQUEUES the mutation (offlineFieldActions, replayed exactly-once app-wide by
// flushOutbox on reconnect) instead of throwing the worker's write away. DNA §14: loss of
// connectivity must not take data away. Behaviour online is byte-identical to the raw writer.
import { enqueueMaterialStatus, enqueueTaskCreate, enqueueNoteCreate } from './offlineFieldActions'
import type { Profile, ProjectNote } from './types'
import type { MaterialStatusAction, NewTaskInput } from './api/tasks'

// navigator.onLine is the fast pre-check; a mid-flight fetch failure is the reliable one, so we
// enqueue on EITHER (parity with TasksTab's task-done / photo degrade path).
function writeIsOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine
}
function isWriteNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /failed to fetch|networkerror|network|fetch|load failed/i.test(message)
}

// Material pick-up / undo / delivery (RPC). Void return — the queue replays the same state
// transition, which is idempotent server-side (no duplicate rows on double-replay).
export const markMaterialStatus = async (taskId: string, action: MaterialStatusAction): Promise<void> => {
  if (!writeIsOnline()) { enqueueMaterialStatus(taskId, action); return }
  try {
    await tasksApi.markMaterialStatus(taskId, action)
  } catch (err) {
    if (isWriteNetworkError(err)) { enqueueMaterialStatus(taskId, action); return }
    throw err
  }
}

// Task creation. Offline returns the optimistic `offline-<clientId>` id so callers proceed as
// with a real id (attachments uploaded against it degrade on their own path).
export const createTask = async (p: Profile, input: NewTaskInput): Promise<string> => {
  if (!writeIsOnline()) return enqueueTaskCreate(input)
  try {
    return await tasksApi.createTask(p, input)
  } catch (err) {
    if (isWriteNetworkError(err)) return enqueueTaskCreate(input)
    throw err
  }
}

// Project-note creation. Offline returns a synthetic ProjectNote so the notes list renders it
// immediately; the real insert replays on reconnect.
export const createProjectNote = async (p: Profile, projectId: string, body: string): Promise<ProjectNote> => {
  if (!writeIsOnline()) return enqueueNoteCreate(p, projectId, body)
  try {
    return await projectsApi.createProjectNote(p, projectId, body)
  } catch (err) {
    if (isWriteNetworkError(err)) return enqueueNoteCreate(p, projectId, body)
    throw err
  }
}
