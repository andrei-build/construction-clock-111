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
