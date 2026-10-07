import { useMemo, useCallback } from 'react'
import { useApiQuery } from '@/hooks/useApi'

export interface KbItem {
  id: string
  name: string
  type: string
  classification?: string
  folderId: string | null
  nodeCount?: number
  edgeCount?: number
}

export interface KbFolderNode {
  id: string
  name: string
  parentFolderId: string | null
  children: KbFolderNode[]
  items: KbItem[]
}

interface RawComp {
  id: string
  name: string
  type?: string
  classification?: string
  folderId?: string | null
  nodeCount?: number
  edgeCount?: number
}
interface RawFolder {
  id: string
  name: string
  parentFolderId: string | null
  position?: number
}

/**
 * All knowledge bases (limit 500, not the server default of 100) arranged in
 * their folder tree. Shared by every graph picker.
 */
export function useKbTree(opts?: { types?: string[] }) {
  const { data: compData, isLoading: l1 } = useApiQuery<{ compilations: RawComp[] }>(
    ['kg', 'compilations', 'all'],
    '/kg/compilations?limit=500',
    { staleTime: 15_000 },
  )
  const { data: folderData, isLoading: l2 } = useApiQuery<{ folders: RawFolder[] }>(
    ['kg', 'folders'],
    '/kg/folders',
    { staleTime: 15_000 },
  )

  const typesKey = opts?.types?.join('|') ?? ''

  const built = useMemo(() => {
    const types = typesKey ? typesKey.split('|') : null
    const items: KbItem[] = (compData?.compilations ?? [])
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type ?? 'RAW',
        classification: c.classification,
        folderId: c.folderId ?? null,
        nodeCount: c.nodeCount,
        edgeCount: c.edgeCount,
      }))
      .filter((c) => !types || types.includes(c.type))
    const byId = new Map(items.map((i) => [i.id, i]))
    const nodes = new Map<string, KbFolderNode>()
    const rawFolders = [...(folderData?.folders ?? [])].sort(
      (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name),
    )
    for (const f of rawFolders) {
      nodes.set(f.id, { id: f.id, name: f.name, parentFolderId: f.parentFolderId, children: [], items: [] })
    }
    const roots: KbFolderNode[] = []
    for (const n of nodes.values()) {
      const parent = n.parentFolderId ? nodes.get(n.parentFolderId) : undefined
      if (parent) parent.children.push(n)
      else roots.push(n)
    }
    const rootItems: KbItem[] = []
    for (const it of items) {
      const f = it.folderId ? nodes.get(it.folderId) : undefined
      if (f) f.items.push(it)
      else rootItems.push(it)
    }
    const sortItems = (a: KbItem, b: KbItem) => a.name.localeCompare(b.name)
    for (const n of nodes.values()) n.items.sort(sortItems)
    rootItems.sort(sortItems)
    return { items, byId, nodes, roots, rootItems }
  }, [compData, folderData, typesKey])

  const pathFor = useCallback(
    (id: string): string[] => {
      const it = built.byId.get(id)
      const path: string[] = []
      let cur = it?.folderId ? built.nodes.get(it.folderId) : undefined
      let guard = 0
      while (cur && guard++ < 50) {
        path.unshift(cur.name)
        cur = cur.parentFolderId ? built.nodes.get(cur.parentFolderId) : undefined
      }
      return path
    },
    [built],
  )

  return {
    items: built.items,
    folders: built.roots,
    rootItems: built.rootItems,
    byId: built.byId,
    pathFor,
    isLoading: l1 || l2,
  }
}
