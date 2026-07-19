import { Link } from 'react-router-dom'
import { Terminal, Plug2, KeyRound } from 'lucide-react'

const STEPS: { icon: typeof Terminal; title: string; desc: string }[] = [
  {
    icon: Terminal,
    title: '1 · Install locally - free',
    desc: 'One command, fully self-hosted. Unlimited tokens from day one.',
  },
  {
    icon: Plug2,
    title: '2 · Connect your AI',
    desc: 'Claude Code, Codex, Cursor or any MCP client - one config block.',
  },
  {
    icon: KeyRound,
    title: '3 · Scale with scoped tokens',
    desc: 'One scoped access token per colleague, project or agent - each sees only what you grant it.',
  },
]

export function CtaSection() {
  return (
    <section className="relative overflow-hidden bg-[#0a0f24] px-6 py-28">
      {/* Glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-[500px] w-[700px] rounded-full bg-indigo-700/15 blur-[120px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-3xl text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-indigo-300 reveal">
          Ground Control - Ready for Launch
        </div>

        <h2 className="mb-6 text-4xl font-bold leading-tight text-white md:text-5xl reveal">
          Your AI deserves
          <br />
          <span className="bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
            solid ground to stand on.
          </span>
        </h2>

        <p className="mx-auto mb-10 max-w-xl text-lg text-slate-400 reveal">
          Stop building on unstructured noise. GCTRL gives your enterprise AI the knowledge foundation it needs to be accurate, explainable, and trustworthy.
        </p>

        <div className="mb-12 grid gap-4 text-left sm:grid-cols-3 reveal">
          {STEPS.map((s) => (
            <div key={s.title} className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 backdrop-blur-sm">
              <s.icon className="mb-3 h-5 w-5 text-indigo-400" strokeWidth={1.75} />
              <p className="text-sm font-semibold text-white">{s.title}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{s.desc}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-4 reveal">
          <Link to="/register" className="btn-cta-primary px-8 py-3.5 text-base" data-umami-event="cta_register">
            Get Started Free
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </Link>
          <a href="mailto:hello@gctrl.tech" className="btn-cta-secondary px-8 py-3.5 text-base">
            Talk to Us
          </a>
        </div>

        <p className="mt-8 text-sm text-slate-500 reveal">
          Fully on-premises · GDPR-ready · No vendor lock-in
        </p>
      </div>
    </section>
  )
}
