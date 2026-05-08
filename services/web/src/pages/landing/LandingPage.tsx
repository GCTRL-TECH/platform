import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useScrollReveal } from '@/hooks/useScrollReveal'
import { HeroSection } from './sections/HeroSection'
import { ProblemSection } from './sections/ProblemSection'
import { SolutionSection } from './sections/SolutionSection'
import { FeaturesSection } from './sections/FeaturesSection'
import { HowItWorksSection } from './sections/HowItWorksSection'
import { ExplainabilitySection } from './sections/ExplainabilitySection'
import { IntegrationsSection } from './sections/IntegrationsSection'
import { CtaSection } from './sections/CtaSection'

function LandingNav() {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 40)
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  return (
    <header
      className={`fixed left-0 right-0 top-0 z-50 transition-all duration-300 ${
        scrolled ? 'landing-nav-scrolled' : 'bg-transparent'
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link to="/" className="flex items-center">
          <img src="/gctrl/horizontal-color-on-darkbg.svg" alt="GCTRL" className="h-7 w-auto" />
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {[
            ['Platform', '#features'],
            ['How It Works', '#how-it-works'],
            ['Integrations', '#integrations'],
          ].map(([label, href]) => (
            <a
              key={label}
              href={href}
              className="text-sm text-slate-400 transition-colors hover:text-white"
            >
              {label}
            </a>
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
          aria-label="Toggle menu" aria-expanded={menuOpen}
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
            {[
              ['Platform', '#features'],
              ['How It Works', '#how-it-works'],
              ['Integrations', '#integrations'],
            ].map(([label, href]) => (
              <a
                key={label}
                href={href}
                className="text-sm text-slate-300"
                onClick={() => setMenuOpen(false)}
              >
                {label}
              </a>
            ))}
            <hr className="border-slate-800" />
            <Link to="/login" className="text-sm text-slate-300">Sign In</Link>
            <Link to="/register" className="btn-cta-primary justify-center">Get Started</Link>
          </nav>
        </div>
      )}
    </header>
  )
}

function LandingFooter() {
  return (
    <footer className="border-t border-slate-800 bg-[#020617] px-6 py-16">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 md:grid-cols-4">
          <div>
            <div className="mb-4">
              <img src="/gctrl/wordmark-white.svg" alt="GCTRL" className="h-5 w-auto" />
            </div>
            <p className="text-sm leading-relaxed text-slate-500">
              The knowledge infrastructure layer for enterprise AI. Ground your data. Command your AI.
            </p>
          </div>

          {[
            {
              title: 'Platform',
              links: [['KEX Extract', '#'], ['FUSE Merge', '#'], ['Knowledge Graphs', '#'], ['Grounded RAG', '#']],
            },
            {
              title: 'Integrations',
              links: [['Neo4j', '#'], ['Qdrant', '#'], ['Google Drive', '#'], ['Microsoft 365', '#']],
            },
            {
              title: 'Company',
              links: [['Sign In', '/login'], ['Get Started', '/register'], ['Contact', 'mailto:hello@gctrl.tech']],
            },
          ].map((col) => (
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
          <p>© {new Date().getFullYear()} GCTRL — Ground Control. All rights reserved.</p>
          <p>Built for enterprises that refuse to hallucinate.</p>
        </div>
      </div>
    </footer>
  )
}

export function LandingPage() {
  useScrollReveal()

  return (
    <div className="min-h-screen bg-[#020617]">
      <LandingNav />
      <main>
        <HeroSection />
        <ProblemSection />
        <SolutionSection />
        <section id="features"><FeaturesSection /></section>
        <section id="how-it-works"><HowItWorksSection /></section>
        <ExplainabilitySection />
        <section id="integrations"><IntegrationsSection /></section>
        <CtaSection />
      </main>
      <LandingFooter />
    </div>
  )
}
