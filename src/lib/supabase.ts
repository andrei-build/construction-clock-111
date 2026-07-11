import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = 'https://gzjfjszfdnmaazursppx.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_j5MDTuAPTStmQSK3yDgHCw_ZbRwJrDm'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
})
