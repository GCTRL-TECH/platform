import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'

// Top-level nav. Section anchors use `/#id` so they work from any page
// (docs / use-cases navigate back to the landing page and scroll). Page links
// (Documentation, Use cases) are real routes.
const NAV: [label: string, href: string][] = [
  ['Platform', '/#features'],
  ['Architecture', '/#architecture'],
  ['Benchmarks', '/#benchmarks'],
  ['Documentation', '/docs'],
  ['Use cases', '/use-cases'],
]

function NavLink({ label, href, onClick }: { label: string; href: string; onClick?: () => void }) {
  const cls = 'text-sm text-slate-400 transition-colors hover:text-white'
  // Route links (no hash) use react-router; anchor links use a plain <a>.
  if (href.startsWith('/') && !href.includes('#')) {
    return (
      <Link to={href} className={cls} onClick={onClick}>
        {label}
      </Link>
    )
  }
  return (
    <a href={href} className={cls} onClick={onClick}>
      {label}
    </a>
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
          <img src="/gctrl/horizontal-color-on-darkbg.svg" alt="GCTRL" className="h-7 w-auto" />
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {NAV.map(([label, href]) => (
            <NavLink key={label} label={label} href={href} />
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link to="/login" className="text-sm text-slate-400 transition-colors hover:text-white">
            Sign In
          </Link>
          <Link to="/register" className="btn-cta-primary !py-2 !px-4 !text-xs">
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
