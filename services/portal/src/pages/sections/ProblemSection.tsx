const PROBLEMS = [
  {
    icon: '🏗️',
    title: 'Data Trapped in Silos',
    body: 'Enterprise knowledge is fragmented across SharePoint, Confluence, S3, databases, and email. AI systems built on raw, disconnected data return inconsistent, unreliable answers.',
  },
  {
    icon: '🔁',
    title: 'Duplicates & Contradictions',
    body: 'The same entity appears under dozens of aliases — different spellings, outdated records, conflicting versions. Without deduplication, your AI learns from noise, not signal.',
  },
  {
    icon: '🌫️',
    title: 'AI Hallucination at Scale',
    body: 'Vector similarity alone cannot enforce factual correctness. Without a structured knowledge layer, your enterprise RAG stack will confidently fabricate answers when it matters most.',
  },
]

export function ProblemSection() {
  return (
    <section className="relative bg-[#020617] px-6 py-28">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">The Problem</p>
          <h2 className="text-4xl font-bold text-white">Enterprise AI is only as good as its data.</h2>
          <p className="mx-auto mt-4 max-w-xl text-slate-400">
            Most organisations skip the hard part — and pay for it in hallucinations, compliance failures, and eroded trust.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {PROBLEMS.map((p, i) => (
            <div
              key={p.title}
              className={`feature-card-landing reveal reveal-delay-${i + 1} p-8`}
            >
              <div className="mb-4 text-3xl">{p.icon}</div>
              <h3 className="mb-2 text-lg font-semibold text-white">{p.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
