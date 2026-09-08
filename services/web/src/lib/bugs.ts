import { apiGet, apiPost, apiPut } from '@/lib/api'

/**
 * Bug reports. Contract shared with api-rs:
 *   POST /api/bugs                         { title, description, pageUrl, userAgent, version } -> { id }
 *   GET  /api/admin/bugs                   -> { bugs: BugReport[] }
 *   PUT  /api/admin/bugs/:id               { status }
 *   POST /api/admin/bugs/:id/decision      { decision: 'admit' | 'decline' }
 *   POST /api/admin/bugs/spec              -> { markdown, bugCount }
 */

export type BugStatus = 'reported' | 'admitted' | 'declined' | 'in_progress' | 'done'

export const BUG_STATUSES: BugStatus[] = ['reported', 'admitted', 'in_progress', 'done', 'declined']

export const BUG_STATUS_LABEL: Record<BugStatus, string> = {
  reported: 'Reported',
  admitted: 'Admitted',
  in_progress: 'In progress',
  done: 'Done',
  declined: 'Declined',
}

export interface BugReport {
  id: string
  title: string
  description: string
  pageUrl: string
  userAgent: string
  version: string
  status: BugStatus
  reporterEmail: string
  createdAt: string
  updatedAt: string
}

export interface NewBugReport {
  title: string
  description: string
  pageUrl: string
  userAgent: string
  version: string
}

export function reportBug(body: NewBugReport): Promise<{ id: string }> {
  return apiPost<{ id: string }>('/bugs', body)
}

export async function listBugs(): Promise<BugReport[]> {
  const data = await apiGet<{ bugs?: BugReport[] }>('/admin/bugs')
  return data.bugs ?? []
}

export function decideBug(id: string, decision: 'admit' | 'decline'): Promise<unknown> {
  return apiPost(`/admin/bugs/${id}/decision`, { decision })
}

export function setBugStatus(id: string, status: BugStatus): Promise<unknown> {
  return apiPut(`/admin/bugs/${id}`, { status })
}

export function createBugSpec(): Promise<{ markdown: string; bugCount: number }> {
  return apiPost<{ markdown: string; bugCount: number }>('/admin/bugs/spec', {})
}
