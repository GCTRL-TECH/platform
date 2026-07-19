import type { ComponentType } from 'react'
import { SilosVignette, ConflictVignette, GovernanceVignette } from './vignettes/CardVignettes'

const PROBLEMS: { Vignette: ComponentType; title: string; body: string }[] = [
  {
    Vignette: SilosVignette,
    title: 'Locked in silos & legacy systems',
    body: 'The knowledge your AI needs is scattered across SharePoint, old mailservers, legacy SQL, and orphaned file shares. Before anything is useful, you have to reach it - and just reaching it is a project of its own.',
  },
  {
    Vignette: ConflictVignette,
    title: 'Messy, duplicated, contradictory',
    body: 'Garbage in, garbage out. Point an LLM at raw, unresolved data and it learns from noise: the same entity under ten names, stale records, conflicting versions. The answers look confident and are quietly wrong.',
  },
  {
    Vignette: GovernanceVignette,
    title: 'Governance is overwhelming',
    body: 'Even once you can reach the data - who is allowed to see what? Classification, clearance, and an audit trail across every source is a task most teams start, dread, and never finish.',
  },
]

export function ProblemSection() {
  return (
    <section className="relative bg-[#020617] px-6 py-28">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">The real problem</p>
          <h2 className="mx-auto max-w-3xl text-4xl font-bold text-white md:text-5xl">
            Your AI is only as good as your data -{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              and most data isn’t ready.
            </span>
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-slate-400">
            Garbage in, garbage out. Before AI can deliver, your knowledge has to be{' '}
            <span className="text-slate-200">accessible</span>, <span className="text-slate-200">clean</span>, and{' '}
            <span className="text-slate-200">governed</span> - and in most enterprises it’s none of the three.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {PROBLEMS.map((p, i) => (
            <div key={p.title} className={`feature-card-landing reveal reveal-delay-${i + 1} p-8`}>
              <p.Vignette />
              <h3 className="mb-2 text-lg font-semibold text-white">{p.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{p.body}</p>
            </div>
          ))}
        </div>

        <p className="mx-auto mt-12 max-w-2xl text-center text-base text-slate-500 reveal">
          GCTRL exists to fix exactly this: it makes the messy, scattered, sensitive data your AI needs{' '}
          <span className="text-slate-300">accessible, clean, and governed</span> - so what goes in is worth what comes out.
        </p>
      </div>
    </section>
  )
}
