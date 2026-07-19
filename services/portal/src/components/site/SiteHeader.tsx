import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Github } from 'lucide-react'

const GITHUB_URL = 'https://github.com/GCTRL-TECH/platform'

// Section anchors use `/#id` so they work from any page (docs / use-cases
// navigate back to the landing page and scroll). Page links are real routes.
const NAV: [label: string, href: string][] = [
  ['Integrations', '/integrations'],
  ['Pricing', '/pricing'],
  ['Documentation', '/docs'],
]

const USE_CASES: [label: string, href: string, desc: string][] = [
  ['Agentic Team Memory', '/use-cases#agentic-team-memory', 'Shared, access-controlled memory for your AI team'],
  ['Airtight Client Projects', '/use-cases#project-isolation', 'One source of truth, per-project isolation — nothing mixes, even by accident'],
  ['Activate Your Legacy Data', '/use-cases#legacy-revival', 'Turn old mailservers, SharePoint & SQL into a clean graph'],
]

const TECHNOLOGY: [label: string, href: string, desc: string][] = [
  ['KEX — Knowledge Extraction', '/docs/tech-kex', 'Unstructured docs to structured graph, locally and fast'],
  ['FUSE — Knowledge Fusion', '/docs/tech-fuse', 'One governed graph from many silos, zero training'],
  ['Classification & Access Control', '/docs/tech-classification', 'Clearance-gated knowledge, built in rather than bolted on'],
  ['Multi-Agent Fabric', '/docs/tech-multi-agent-fabric', 'One governed memory layer for every agent framework'],
  ['Cloaking', '/docs/tech-cloaking', 'Use frontier cloud models without exposing your identities'],
  ['Sovereign & On-Prem', '/docs/tech-sovereign', 'Data never leaves, deterministic cost, air-gap-capable'],
  ['Talk to Graph', '/docs/tech-talk-to-graph', 'Grounded, cited, GDPR-compliant chat over your graph'],
  ['Why a Memory Layer', '/docs/tech-memory-layer', 'The missing governed-memory tier between data and AI'],
]

function ChevronDown() {
  return (
    <svg className="h-3.5 w-3.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function NavLink({ label, href, onClick }: { label: string; href: string; onClick?: () => void }) {
  const cls = 'text-sm text-slate-400 transition-colors hover:text-white'
  if (href.startsWith('/') && !href.includes('#')) {
    return <Link to={href} className={cls} onClick={onClick}>{label}</Link>
  }
  return <a href={href} className={cls} onClick={onClick}>{label}</a>
}

function UseCasesDropdown() {
  return (
    <div className="group relative">
      <Link to="/use-cases" className="flex items-center gap-1 text-sm text-slate-400 transition-colors hover:text-white">
        Use cases <ChevronDown />
      </Link>
      {/* pt-3 bridges the gap so the panel doesn't close while moving onto it */}
      <div className="invisible absolute left-1/2 top-full z-50 -translate-x-1/2 pt-3 opacity-0 transition-all duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div className="w-72 rounded-xl border border-slate-800 bg-slate-950/95 p-1.5 shadow-2xl backdrop-blur">
          {USE_CASES.map(([label, href, desc]) => (
            <Link key={href} to={href} className="block rounded-lg px-3 py-2 transition-colors hover:bg-slate-800/80">
              <p className="text-sm font-medium text-slate-100">{label}</p>
              <p className="mt-0.5 text-xs leading-snug text-slate-500">{desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

function TechnologyDropdown() {
  return (
    <div className="group relative">
      <Link to="/docs/tech-kex" className="flex items-center gap-1 text-sm text-slate-400 transition-colors hover:text-white">
        Technology <ChevronDown />
      </Link>
      {/* pt-3 bridges the gap so the panel doesn't close while moving onto it */}
      <div className="invisible absolute left-1/2 top-full z-50 -translate-x-1/2 pt-3 opacity-0 transition-all duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div className="w-80 rounded-xl border border-slate-800 bg-slate-950/95 p-1.5 shadow-2xl backdrop-blur">
          {TECHNOLOGY.map(([label, href, desc]) => (
            <Link key={href} to={href} className="block rounded-lg px-3 py-2 transition-colors hover:bg-slate-800/80">
              <p className="text-sm font-medium text-slate-100">{label}</p>
              <p className="mt-0.5 text-xs leading-snug text-slate-500">{desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 40)
    handler()
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  return (
    <header
      className={`landing-nav fixed left-0 right-0 top-0 z-50 transition-all duration-300 ${
        scrolled ? 'landing-nav-scrolled' : 'bg-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link to="/" className="flex items-center">
          <img src="/gctrl/horizontal-color-on-darkbg.svg?v=2" alt="GCTRL" className="h-7 w-auto" />
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {NAV.map(([label, href]) => (
            <NavLink key={label} label={label} href={href} />
          ))}
          <UseCasesDropdown />
          <TechnologyDropdown />
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="GCTRL on GitHub"
            className="text-slate-400 transition-colors hover:text-white"
            data-umami-event="header_github"
          >
            <Github className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </a>
          <Link to="/login" className="text-sm text-slate-400 transition-colors hover:text-white">
            Sign In
          </Link>
          <Link to="/register" className="btn-cta-primary !py-2 !px-4 !text-xs" data-umami-event="cta_register">
            Get Started
          </Link>
        </div>

        <button
          className="flex items-center justify-center rounded-lg p-2 text-slate-400 hover:text-white md:hidden"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
        >
          {menuOpen ? (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </div>

      {menuOpen && (
        <div className="border-t border-slate-800 bg-slate-950/95 px-6 py-4 md:hidden">
          <nav className="flex flex-col gap-3">
            {NAV.map(([label, href]) => (
              <NavLink key={label} label={label} href={href} onClick={() => setMenuOpen(false)} />
            ))}
            <div>
              <Link to="/use-cases" className="text-sm text-slate-300" onClick={() => setMenuOpen(false)}>
                Use cases
              </Link>
              <div className="mt-2 flex flex-col gap-2 border-l border-slate-800 pl-3">
                {USE_CASES.map(([label, href]) => (
                  <Link key={href} to={href} className="text-sm text-slate-400 hover:text-white" onClick={() => setMenuOpen(false)}>
                    {label}
                  </Link>
                ))}
              </div>
            </div>
            <div>
              <Link to="/docs/tech-kex" className="text-sm text-slate-300" onClick={() => setMenuOpen(false)}>
                Technology
              </Link>
              <div className="mt-2 flex flex-col gap-2 border-l border-slate-800 pl-3">
                {TECHNOLOGY.map(([label, href]) => (
                  <Link key={href} to={href} className="text-sm text-slate-400 hover:text-white" onClick={() => setMenuOpen(false)}>
                    {label}
                  </Link>
                ))}
              </div>
            </div>
            <hr className="border-slate-800" />
            <Link to="/login" className="text-sm text-slate-300" onClick={() => setMenuOpen(false)}>
              Sign In
            </Link>
            <Link to="/register" className="btn-cta-primary justify-center" onClick={() => setMenuOpen(false)}>
              Get Started
            </Link>
          </nav>
        </div>
      )}
    </header>
  )
}
