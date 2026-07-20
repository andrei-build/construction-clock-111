import { supabase } from '../supabase'
import {
  normalizeAssignmentRows,
  normalizeOnShiftRows,
  normalizeOrgSnapshot,
  normalizeUnassignedRows,
} from '../dashboardSnapshot'
import type { CurrentAssignmentRow, OnShiftNowRow, OrgSnapshot, UnassignedWorkerRow } from '../types'

export async function getOrgSnapshot(): Promise<OrgSnapshot> {
  const { data, error } = await supabase.rpc('org_snapshot')
  if (error) throw error
  return normalizeOrgSnapshot(data)
}

export async function getOnShiftNow(): Promise<OnShiftNowRow[]> {
  const { data, error } = await supabase.from('v_on_shift_now').select('*')
  if (error) throw error
  return normalizeOnShiftRows(data)
}

export async function getCurrentAssignments(): Promise<CurrentAssignmentRow[]> {
  const { data, error } = await supabase.from('v_assignments_current').select('*')
  if (error) throw error
  return normalizeAssignmentRows(data)
}

export async function getUnassignedWorkers(): Promise<UnassignedWorkerRow[]> {
  const { data, error } = await supabase.from('v_workers_unassigned').select('*')
  if (error) throw error
  return normalizeUnassignedRows(data)
}
