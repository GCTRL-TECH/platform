/**
 * Where a knowledge base LIVES — the one place the frontend turns `folderId` into a
 * readable path, groups lists by it and filters on it.
 *
 * Every list of knowledge bases used to be a flat, unsorted run of names, ordered by
 * creation date. On an instance where all colleagues share one account that is a wall:
 * dozens of same-ish names ("Personal", "Standard", one "MV Tech" per room) with nothing
 * to tell them apart, and a picker that just keeps scrolling. The folder path IS the
 * distinguishing information (`Users/<person>`, `Projects/<client>`, `Global/<topic>`),
 * so it belongs next to the name everywhere, and the list belongs grouped by it.
 *
 * Pure functions plus one hook, so the grouping rule is testable and every picker shares it.
 */
import { useMemo } from 'react'
import { useApiQuery } from '@/hooks/useApi'

export interface KbFolder {
  id: string
  name: string
  parentFolderId: string | null
}

/** Anything a picker can show: an id, a name, and where it is filed. */
export interface FiledKb {
  id: string
  name: string
  folderId?: string | null
}

/** Shown for graphs that are not filed anywhere. They exist (fusion output, older
 *  imports) and hiding them would be worse than naming the gap. */
export const NO_FOLDER_LABEL = 'No folder'

/** id → "Users/f.chiaramonte", cycle-safe (a folder tree can contain a cycle —
 *  the check on re-parenting is newer than the data, see kg.rs `folder_paths`). */
export function buildFolderPaths(folders: KbFolder[]): Record<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const out: Record<string, string> = {}
  for (const f of folders) {
    const segments: string[] = []
    const seen = new Set<string>()
    let cur: KbFolder | undefined = f
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      segments.unshift(cur.name)
      cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : undefined
    }
    out[f.id] = segments.join('/')
  }
  return out
}

/** The path of one graph, or `NO_FOLDER_LABEL`. */
export function folderPathOf(folderId: string | null | undefined, paths: Record<string, string>): string {
  if (!folderId) return NO_FOLDER_LABEL
  return paths[folderId] ?? NO_FOLDER_LABEL
}

/** Root-folder order: people first (that is where you look for your own), then the
 *  shared buckets, unfiled last. Within a rank the path sorts alphabetically. */
const ROOT_RANK: Record<string, number> = { Users: 0, Projects: 1, Global: 2 }

export function comparePaths(a: string, b: string): number {
  if (a === b) return 0
  if (a === NO_FOLDER_LABEL) return 1
  if (b === NO_FOLDER_LABEL) return -1
  const ra = ROOT_RANK[a.split('/')[0]] ?? 3
  const rb = ROOT_RANK[b.split('/')[0]] ?? 3
  return ra !== rb ? ra - rb : a.localeCompare(b)
}

export interface KbGroup<T> {
  path: string
  items: T[]
}

/** Group a list of graphs by folder path, sorted by `comparePaths`, names sorted
 *  inside each group. The input order (created_at DESC) is deliberately dropped —
 *  a picker is looked at by place, not by age. */
export function groupByFolder<T extends FiledKb>(items: T[], paths: Record<string, string>): KbGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const path = folderPathOf(item.folderId, paths)
    const bucket = groups.get(path)
    if (bucket) bucket.push(item)
    else groups.set(path, [item])
  }
  return [...groups.entries()]
    .map(([path, list]) => ({ path, items: [...list].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => comparePaths(a.path, b.path))
}

/** Search matches the NAME and the FOLDER PATH — typing "bosak" must find the personal
 *  graph of that colleague even when the name itself carries no person. */
export function matchesKbQuery(item: FiledKb, paths: Record<string, string>, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystack = `${item.name} ${folderPathOf(item.folderId, paths)}`.toLowerCase()
  return needle.split(/\s+/).every((part) => haystack.includes(part))
}

/** The folder paths of the signed-in account. Cached under the same query key the
 *  folder view uses, so it is usually already in the cache. */
export function useFolderPaths(): Record<string, string> {
  const { data } = useApiQuery<{ folders: KbFolder[] }>(['kg', 'folders'], '/kg/folders')
  return useMemo(() => buildFolderPaths(data?.folders ?? []), [data])
}

/** Search + grouping in one call — every picker does exactly this. `matched` /
 *  `total` feed the "3 of 134" hint that tells a user the list is filtered, not short. */
export function useKbGroups<T extends FiledKb>(
  items: T[],
  query: string,
): { groups: KbGroup<T>[]; paths: Record<string, string>; matched: number; total: number } {
  const paths = useFolderPaths()
  return useMemo(() => {
    const hits = items.filter((i) => matchesKbQuery(i, paths, query))
    return { groups: groupByFolder(hits, paths), paths, matched: hits.length, total: items.length }
  }, [items, paths, query])
}
