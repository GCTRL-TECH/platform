import { Link } from 'react-router-dom'
import { Network, Zap, Lock, ArrowRight, Terminal } from 'lucide-react'

const features = [
  {
    icon: Network,
    title: 'Knowledge Graph Extraction',
    desc: 'Extract structured entities and relationships from any document — PDFs, URLs, plain text. GPU-accelerated on your hardware.',
  },
  {
    icon: Zap,
    title: 'Semantic Fusion Engine',
    desc: 'Merge multiple knowledge graphs with high-precision entity matching. Powered by a proprietary 3-stage resolution pipeline.',
  },
  {
    icon: Lock,
    title: 'Fully On-Prem',
    desc: 'Your data never leaves your infrastructure. DSGVO-compliant by design. Deploy with a single command.',
  },
]

export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 overflow-x-hidden">
      {/* Nav */}
      <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 py-4 border-b border-slate-800/50 bg-[#020617]/80 backdrop-blur-md">
        <span className="text-lg font-bold tracking-tight">GCTRL</span>
        <div className="flex items-center gap-3">
          <Link to="/login" className="text-sm text-slate-400 hover:text-slate-200 transition-colors">Sign in</Link>
          <Link to="/register" className="btn-primary text-xs px-3 py-1.5">Get started</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-32 pb-24 px-6 text-center hero-grid-bg">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-indigo-950/10 to-[#020617]" />
        <div className="relative max-w-3xl mx-auto space-y-6">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-indigo-500/20 bg-indigo-500/5 text-xs text-indigo-300">
            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400 animate-pulse" />
            On-Prem Knowledge Graph Platform
          </div>
          <h1 className="text-5xl font-bold text-white leading-tight tracking-tight">
            Build knowledge graphs<br />
            <span className="text-indigo-400">that stay yours</span>
          </h1>
          <p className="text-lg text-slate-400 max-w-xl mx-auto leading-relaxed">
            Extract, fuse, and query enterprise knowledge graphs — entirely on your own infrastructure.
            No data leaves your network.
          </p>
          <div className="flex items-center justify-center gap-4 pt-2">
            <Link to="/register" className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 hover:bg-indigo-500 transition-all hover:-translate-y-0.5">
              Get started free
              <ArrowRight size={16} />
            </Link>
            <a href="#install" className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 px-6 py-3 text-sm font-semibold text-slate-200 hover:border-slate-500 hover:bg-slate-800/80 transition-all hover:-translate-y-0.5">
              <Terminal size={16} />
              Install
            </a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-6 max-w-5xl mx-auto">
        <div className="grid md:grid-cols-3 gap-6">
          {features.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 hover:border-indigo-500/40 hover:bg-slate-800/60 transition-all duration-300">
              <div className="w-10 h-10 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mb-4">
                <Icon size={18} className="text-indigo-400" />
              </div>
              <h3 className="text-base font-semibold text-white mb-2">{title}</h3>
              <p className="text-sm text-slate-400 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Install command */}
      <section id="install" className="py-20 px-6 max-w-3xl mx-auto text-center space-y-6">
        <h2 className="text-3xl font-bold text-white">Deploy in one command</h2>
        <p className="text-slate-400">After registering, use your license key to install GCTRL on any Linux machine with Docker.</p>
        <div className="flex items-center gap-3 p-4 rounded-xl border border-slate-700 bg-slate-900/80 font-mono text-sm text-left">
          <Terminal size={16} className="text-slate-500 shrink-0" />
          <span className="text-slate-300">curl -fsSL https://gctrl.tech/install | bash</span>
        </div>
        <Link to="/register" className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 hover:bg-indigo-500 transition-all hover:-translate-y-0.5">
          Create free account
          <ArrowRight size={16} />
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-8 px-6 text-center text-xs text-slate-600">
        © {new Date().getFullYear()} GCTRL. All rights reserved.
      </footer>
    </div>
  )
}
