import { ConflictsPanel } from '@/components/conflicts/ConflictsPanel'

/**
 * Knowledge Quality — a dedicated home for reconciling contradictory knowledge.
 * Conflicts are keyed per entity (not per graph), so they belong on one global
 * triage surface rather than buried under Access Control (which is about who can
 * access what, not what's true).
 */
export default function KnowledgeQualityPage() {
  return (
    <div className="space-y-6 animate-slide-up">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Knowledge Quality</h2>
        <p className="mt-1 text-sm text-slate-500">
          When two sources disagree about the same entity — say, two different values
          for one company’s CEO — the fact lands here for you to reconcile. Each card
          shows the competing values and the document each came from, so you can pick
          the correct one.
        </p>
      </div>

      <ConflictsPanel />
    </div>
  )
}
