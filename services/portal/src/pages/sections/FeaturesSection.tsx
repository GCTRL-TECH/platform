/**
 * The "Compliance & Guardrails" section.
 *
 * Enterprise AI doesn't lose because it's not clever — it loses because it
 * can't be defended in a room with the CISO, DPO, and procurement. This
 * section positions GCTRL as the layer that turns "yes to AI" into a
 * conversation you can actually win: fine-grained access, forensic audit,
 * standards-ready architecture, and a viable path to activate legacy data
 * without breaking the things compliance has spent ten years building.
 */
const STANDARDS = ['GDPR', 'ISO 27001', 'SOC 2', 'TISAX', 'NIS2']

const PILLARS = [
  {
    icon: '🔐',
    tag: 'Access',
    title: 'Fine-grained rights management',
    body: 'Per-element classification down to nodes, edges, and chunks. Scoped tokens for every user and every agent. Decide who sees what — and prove it on demand.',
  },
  {
    icon: '📜',
    tag: 'Audit',
    title: 'Forensic audit trail',
    body: 'Every retrieval, every classification change, every scope grant — captured immutably with caller, context, and verdict. Court-ready exports out of the box.',
  },
  {
    icon: '⚖️',
    tag: 'Compliance',
    title: 'Compliance-ready by design',
    body: 'GDPR, ISO 27001, SOC 2, and TISAX shaped the schema, not the marketing page. A memory-safe Rust core enforces the controls so they map cleanly to your control objectives.',
  },
  {
    icon: '🗂️',
    tag: 'Legacy',
    title: 'Legacy data, modernised',
    body: 'Turn SharePoint archives, decade-old SQL, and orphaned email stores into queryable knowledge — without losing provenance, lineage, or retention rules.',
  },
  {
    icon: '🚀',
    tag: 'Transformation',
    title: 'Forward without breaking',
    body: 'Roll out AI in phases. Run agents over fully classified data with reversible scope changes and rollback playbooks your runbook can actually execute under pressure.',
  },
  {
    icon: '🤝',
    tag: 'Trust',
    title: 'Defensible by default',
    body: 'Open source so your security team can review every line. Every retrieval ships with the receipts your CISO, your auditors, and your DPO will accept before procurement signs.',
  },
]

export function FeaturesSection() {
  return (
    <section className="relative overflow-hidden bg-[#0a0f24] px-6 py-28">
      {/* Subtle radial glow behind the headline — anchors the section. */}
      <div className="pointer-events-none absolute left-1/2 top-12 h-[320px] w-[640px] -translate-x-1/2 rounded-full bg-indigo-600/10 blur-[120px]" />

      <div className="relative mx-auto max-w-6xl">
        <div className="mb-10 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">
            Compliance &amp; Guardrails
          </p>
          <h2 className="mx-auto max-w-3xl text-4xl font-bold leading-tight text-white md:text-5xl">
            Yes to AI.{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              Without the compromises.
            </span>
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-slate-400">
            Enterprise AI doesn’t just need capability — it needs auditable guardrails, defensible
            access control, and a path that turns legacy data into a moat instead of a liability.
          </p>
        </div>

        {/* Compliance standards strip */}
        <div className="mb-16 flex flex-wrap items-center justify-center gap-3 reveal">
          {STANDARDS.map((std) => (
            <span key={std} className="glass-pill">
              <svg className="h-3.5 w-3.5 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              {std}
            </span>
          ))}
        </div>

        {/* Pillar grid — 3×2 on desktop, 2×3 on tablet, single column on mobile */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {PILLARS.map((p, i) => (
            <div key={p.title} className={`feature-card-landing reveal reveal-delay-${(i % 3) + 1}`}>
              <div className="mb-4 flex items-start justify-between">
                <span className="text-2xl">{p.icon}</span>
                <span className="rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-400">
                  {p.tag}
                </span>
              </div>
              <h3 className="mb-2 font-semibold text-white">{p.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
