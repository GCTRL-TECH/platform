/**
 * VisionSection - the closing thesis: where the agent era is heading and why
 * sovereignty wins. Sits between the proof (benchmarks) and the CTA so the
 * page reads problem → solution → proof → vision → act.
 */
export function VisionSection() {
  return (
    <section className="relative bg-[#020617] px-6 py-24">
      <div className="reveal mx-auto max-w-3xl rounded-2xl border border-indigo-500/20 bg-indigo-500/[0.06] p-8 text-center">
        <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">Where this is heading</p>
        <p className="text-lg leading-relaxed text-slate-300">
          Soon, most software will be operated by <span className="font-medium text-white">agents</span> - and
          agents get swapped like tools, while tokens and compute only get more expensive. In that world, one
          thing must never live inside someone else's product:{' '}
          <span className="font-medium text-white">your knowledge</span>. GCTRL aggregates it from every source,
          every employee, every agent session into one governed knowledge fabric -{' '}
          <span className="font-medium text-white">owned by you, on your infrastructure</span>. Switch to Claude,
          Codex, or open source tomorrow: your knowledge comes along.{' '}
          <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text font-semibold text-transparent">
            That's not a feature. That's infrastructure.
          </span>
        </p>
      </div>
    </section>
  )
}
