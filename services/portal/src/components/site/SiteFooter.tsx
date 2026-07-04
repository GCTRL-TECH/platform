import { Link } from 'react-router-dom'
import { Github } from 'lucide-react'

const GITHUB_URL = 'https://github.com/GCTRL-TECH/deploy'

const COLUMNS: { title: string; links: [label: string, href: string][] }[] = [
  {
    title: 'Platform',
    links: [
      ['KEX Extract', '/docs/modules'],
      ['FUSE Merge', '/docs/modules'],
      ['Knowledge Graphs', '/docs/architecture'],
      ['Grounded RAG', '/docs/modules'],
    ],
  },
  {
    title: 'Resources',
    links: [
      ['Documentation', '/docs'],
      ['Use Cases', '/use-cases'],
      ['Benchmarks', '/docs/benchmarks'],
      ['Architecture', '/docs/architecture'],
    ],
  },
  {
    title: 'Company',
    links: [
      ['Sign In', '/login'],
      ['Get Started', '/register'],
      ['Contact', 'mailto:hello@gctrl.tech'],
    ],
  },
]

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-800 bg-[#020617] px-6 py-16">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 md:grid-cols-4">
          <div>
            <div className="mb-4">
              <img src="/gctrl/wordmark-white.svg?v=2" alt="GCTRL" className="h-5 w-auto" />
            </div>
            <p className="text-sm leading-relaxed text-slate-500">
              The knowledge infrastructure layer for enterprise AI. Ground your data. Command your AI.
            </p>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
            >
              <Github className="h-4 w-4" strokeWidth={1.75} />
              GitHub
            </a>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">{col.title}</p>
              <ul className="space-y-2">
                {col.links.map(([label, href]) => (
                  <li key={label}>
                    {href.startsWith('/') ? (
                      <Link to={href} className="text-sm text-slate-500 transition-colors hover:text-slate-300">
                        {label}
                      </Link>
                    ) : (
                      <a href={href} className="text-sm text-slate-500 transition-colors hover:text-slate-300">
                        {label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-slate-800 pt-8 text-xs text-slate-600 sm:flex-row">
          <p>© {new Date().getFullYear()} Cinque Monti Ltd. — GCTRL (Ground Control). All rights reserved.</p>
          <div className="flex items-center gap-4">
            <Link to="/imprint" className="transition-colors hover:text-slate-300">Imprint</Link>
            <Link to="/privacy" className="transition-colors hover:text-slate-300">Privacy Policy</Link>
          </div>
        </div>
      </div>
    </footer>
  )
}
