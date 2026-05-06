import { Link } from 'react-router-dom'

export function HeroSection() {
  return (
    <section className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#020617] px-6 pt-20">
      {/* Grid background */}
      <div className="hero-grid-bg pointer-events-none absolute inset-0" />

      {/* Radial glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-[600px] w-[600px] rounded-full bg-indigo-600/10 blur-[120px]" />
      </div>

      {/* Concentric ring pulses */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="animate-ring-1 absolute h-[360px] w-[360px] rounded-full border border-indigo-500/20" />
        <div className="animate-ring-2 absolute h-[520px] w-[520px] rounded-full border border-indigo-500/15" />
        <div className="animate-ring-3 absolute h-[680px] w-[680px] rounded-full border border-indigo-500/10" />
      </div>

      {/* Mission Control icon cluster — top right */}
      <div className="pointer-events-none absolute right-8 top-28 hidden opacity-30 lg:block">
        <div className="flex flex-col gap-2">
          {[
            [0.55, 0.35, 0.65, 0.40],
            [0.70, 0.50, 0.30, 0.60],
            [0.45, 0.75, 0.55, 0.35],
          ].map((row, r) => (
            <div key={r} className="flex gap-2">
              {row.map((opacity, c) => (
                <div
                  key={c}
                  className="h-8 w-12 rounded border border-indigo-500/30 bg-indigo-900/20"
                  style={{ opacity }}
                />
              ))}
            </div>
          ))}
        </div>
        <p className="mt-3 text-center text-[10px] font-mono uppercase tracking-widest text-indigo-400/60">
          Mission Control
        </p>
      </div>

      {/* Main content */}
      <div className="relative z-10 mx-auto max-w-4xl text-center">
        {/* Badge */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-300">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
          Enterprise Knowledge Infrastructure
        </div>

        <h1 className="mb-6 text-5xl font-bold leading-tight tracking-tight text-white md:text-6xl lg:text-7xl">
          Ground Your AI.
          <br />
          <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
            Command Your Data.
          </span>
        </h1>

        <p className="mx-auto mb-10 max-w-2xl text-lg leading-relaxed text-slate-400">
          GCTRL is the knowledge infrastructure layer that extracts, deduplicates, and harmonises enterprise data into a structured, explainable knowledge graph — so your AI has a firm grip on reality, not hallucinations.
        </p>

        {/* CTAs */}
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link to="/register" className="btn-cta-primary">
            Get Started Free
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </Link>
          <Link to="/login" className="btn-cta-secondary">
            Sign In
          </Link>
        </div>

        {/* Trust signals */}
        <div className="mt-14 flex flex-wrap items-center justify-center gap-6 text-xs text-slate-500">
          {['GDPR-Ready', 'Fully On-Prem', 'Neo4j + Qdrant Native', 'Open Connectors'].map((tag) => (
            <span key={tag} className="flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5 text-emerald-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              {tag}
            </span>
          ))}
        </div>
      </div>

      {/* Scroll cue */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 animate-bounce text-slate-600">
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </section>
  )
}
