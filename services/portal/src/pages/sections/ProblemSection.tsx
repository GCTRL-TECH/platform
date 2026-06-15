const PROBLEMS = [
  {
    icon: '🪪',
    title: "You can't prove who saw what",
    body: 'The moment AI touches sensitive data, you owe an answer to the CISO, the DPO, and the auditor: who accessed which fact, at what clearance, and why. Most stacks bolt access control on as an afterthought — or skip it and hope.',
  },
  {
    icon: '🗄️',
    title: 'Your best knowledge is locked away',
    body: 'The data your AI needs most is trapped in decade-old SharePoint, legacy SQL, email archives and orphaned file shares — fragmented, duplicated, contradictory, and impossible to use at scale. So it stays dark.',
  },
  {
    icon: '⚠️',
    title: 'One confident wrong answer is a breach',
    body: 'Vector similarity cannot enforce truth — or clearance. In a regulated room, an unsourced answer or an over-shared fact isn’t a glitch. It’s a liability with your name on it.',
  },
]

export function ProblemSection() {
  return (
    <section className="relative bg-[#020617] px-6 py-28">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">The real problem</p>
          <h2 className="mx-auto max-w-3xl text-4xl font-bold text-white md:text-5xl">
            Enterprise AI doesn’t fail on intelligence.{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              It fails on trust.
            </span>
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-slate-400">
            The model was never the hard part. Safely connecting it to your real, sensitive, scattered data —
            and keeping control of who sees what — is where every enterprise rollout stalls.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {PROBLEMS.map((p, i) => (
            <div key={p.title} className={`feature-card-landing reveal reveal-delay-${i + 1} p-8`}>
              <div className="mb-4 text-3xl">{p.icon}</div>
              <h3 className="mb-2 text-lg font-semibold text-white">{p.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{p.body}</p>
            </div>
          ))}
        </div>

        <p className="mx-auto mt-12 max-w-2xl text-center text-base text-slate-500 reveal">
          Solve those three, and AI stops being a risk you defend and becomes an advantage you compound. That’s the
          whole point of GCTRL.
        </p>
      </div>
    </section>
  )
}
