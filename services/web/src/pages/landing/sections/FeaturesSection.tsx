const FEATURES = [
  {
    icon: '⚡',
    title: 'KEX — Knowledge Extraction',
    body: 'Ingest documents, databases, APIs, and web sources. GCTRL extracts structured entities, relationships, and facts — turning unstructured content into queryable knowledge.',
    tag: 'Extraction',
  },
  {
    icon: '🔀',
    title: 'FUSE — Entity Resolution',
    body: 'Identify and merge duplicate entities across sources. FUSE applies ML-driven matching with configurable rules, collapsing thousands of aliases into single canonical records.',
    tag: 'Deduplication',
  },
  {
    icon: '🕸️',
    title: 'Knowledge Graph',
    body: 'Store your harmonised knowledge in a native Neo4j graph. Full relationship traversal, lineage tracking, and versioning — every fact traceable to its source.',
    tag: 'Storage',
  },
  {
    icon: '🎯',
    title: 'Grounded RAG',
    body: 'Replace raw vector retrieval with graph-grounded context. Your LLM answers are anchored to verified facts with complete source attribution — zero hallucination tolerance.',
    tag: 'AI Grounding',
  },
  {
    icon: '🔌',
    title: 'Open Connectors',
    body: 'Out-of-the-box connectors for Google Drive, M365, Confluence, GitHub, Slack, and more. REST API + webhook triggers for any other source.',
    tag: 'Integration',
  },
  {
    icon: '🔒',
    title: 'Multi-Clearance Classification',
    body: 'Apply document-level and entity-level security classifications. Control who can query what — with full audit trails for every knowledge access event.',
    tag: 'Governance',
  },
]

export function FeaturesSection() {
  return (
    <section className="relative bg-[#0a0f24] px-6 py-28">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">Platform Capabilities</p>
          <h2 className="text-4xl font-bold text-white">Everything your enterprise AI needs.</h2>
          <p className="mx-auto mt-4 max-w-xl text-slate-400">
            From raw ingestion to grounded generation — the full knowledge pipeline in one platform.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <div key={f.title} className={`feature-card-landing reveal reveal-delay-${(i % 3) + 1}`}>
              <div className="mb-4 flex items-start justify-between">
                <span className="text-2xl">{f.icon}</span>
                <span className="rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-400">
                  {f.tag}
                </span>
              </div>
              <h3 className="mb-2 font-semibold text-white">{f.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
