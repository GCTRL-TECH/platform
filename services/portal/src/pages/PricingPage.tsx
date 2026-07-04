import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import { SiteHeader } from '@/components/site/SiteHeader'
import { SiteFooter } from '@/components/site/SiteFooter'
import { Seo } from '@/components/Seo'

const CONTACT = 'mailto:hello@gctrl.tech'

type Tier = {
  name: string
  tagline: string
  price: string
  priceNote?: string
  cta: { label: string; href: string; event: string }
  features: string[]
  foot?: string
  featured?: boolean
  badge?: string
}

const TIERS: Tier[] = [
  {
    name: 'Free',
    tagline: 'For non-commercial private users.',
    price: 'Free',
    priceNote: 'forever',
    cta: { label: 'Get started free', href: '/register', event: 'pricing_free' },
    features: [
      'All four modules — KEX, FUSE, Knowledge Graphs, Talk-to-Graph',
      '100% local & self-hosted',
      'Local Ollama inference — GDPR by design',
      'MCP gateway — connect Claude Code, Cursor, Codex',
      'Graph-native memory layer + auto-wiki',
      'Community support',
    ],
    foot: 'Non-commercial, private use only.',
  },
  {
    name: 'Business',
    tagline: 'For teams and companies.',
    price: 'Coming soon',
    priceNote: 'pricing to be announced',
    featured: true,
    badge: 'Coming soon',
    cta: { label: 'Get in touch', href: `${CONTACT}?subject=GCTRL%20Business`, event: 'pricing_business' },
    features: [
      'Everything in Free — licensed for commercial use',
      'Team access control & per-element classification',
      'Scoped colleague tokens — airtight project isolation',
      'Tuned entity-resolution profile',
      'Priority support',
    ],
  },
  {
    name: 'Individual',
    tagline: 'Tailored to your organization.',
    price: "Let's talk",
    priceNote: 'custom',
    cta: { label: 'Reach out to us', href: `${CONTACT}?subject=GCTRL%20Individual`, event: 'pricing_individual' },
    features: [
      'Everything in Business',
      'On-prem / air-gapped & sovereign deployment',
      'TISAX & ISO 27001-aware hardening',
      'SSO / SCIM',
      'Custom integrations & connectors',
      'Dedicated support & SLAs',
    ],
  },
]

function CtaButton({ tier }: { tier: Tier }) {
  const base = tier.featured
    ? 'btn-cta-primary w-full justify-center'
    : 'inline-flex w-full items-center justify-center rounded-xl border border-slate-700 bg-slate-800/60 px-5 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-800'
  if (tier.cta.href.startsWith('/')) {
    return (
      <Link to={tier.cta.href} className={base} data-umami-event={tier.cta.event}>
        {tier.cta.label}
      </Link>
    )
  }
  return (
    <a href={tier.cta.href} className={base} data-umami-event={tier.cta.event}>
      {tier.cta.label}
    </a>
  )
}

export function PricingPage() {
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  return (
    <div className="min-h-screen bg-[#020617]">
      <Seo
        title="Pricing — GCTRL"
        description="GCTRL is free forever for non-commercial private use, fully self-hosted with local inference. Business and Individual tiers add team access control and sovereign deployment."
        path="/pricing"
      />
      <SiteHeader />

      {/* Hero */}
      <section className="relative overflow-hidden px-6 pt-32 pb-12">
        <div className="pointer-events-none absolute left-1/2 top-0 -z-0 h-96 w-[40rem] -translate-x-1/2 rounded-full bg-indigo-600/10 blur-[120px]" />
        <div className="relative mx-auto max-w-3xl text-center">
          <span className="glass-pill mb-5">Pricing</span>
          <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Simple,{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              sovereign
            </span>{' '}
            pricing
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-slate-400">
            Free forever for private use. Built to run entirely on your own infrastructure — your data never
            leaves your machine, on any plan.
          </p>
        </div>
      </section>

      {/* Tiers */}
      <section className="px-6 pb-24">
        <div className="mx-auto grid max-w-6xl items-start gap-6 lg:grid-cols-3">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`relative flex flex-col rounded-3xl border p-8 backdrop-blur-sm ${
                tier.featured
                  ? 'border-indigo-400/40 bg-indigo-500/[0.07] shadow-2xl shadow-indigo-900/30 lg:-mt-3 lg:mb-3'
                  : 'border-slate-800 bg-slate-900/40'
              }`}
            >
              {tier.badge && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-indigo-400/40 bg-indigo-500/20 px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-indigo-200">
                  {tier.badge}
                </span>
              )}

              <h2 className="text-xl font-bold text-white">{tier.name}</h2>
              <p className="mt-1 text-sm text-slate-400">{tier.tagline}</p>

              <div className="mt-6 flex items-baseline gap-2">
                <span className="text-4xl font-bold text-white">{tier.price}</span>
                {tier.priceNote && <span className="text-sm text-slate-500">{tier.priceNote}</span>}
              </div>

              <div className="mt-6">
                <CtaButton tier={tier} />
              </div>

              <ul className="mt-8 space-y-3">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Check size={16} className="mt-0.5 shrink-0 text-indigo-400" />
                    <span className="text-sm leading-relaxed text-slate-300">{f}</span>
                  </li>
                ))}
              </ul>

              {tier.foot && (
                <p className="mt-6 border-t border-slate-800 pt-4 text-xs text-slate-500">{tier.foot}</p>
              )}
            </div>
          ))}
        </div>

        <p className="mx-auto mt-12 max-w-2xl text-center text-sm text-slate-500">
          Every plan is fully self-hosted with local inference — DSGVO/GDPR by design. Questions about
          licensing or volume?{' '}
          <a href={`${CONTACT}?subject=GCTRL%20Pricing`} className="text-indigo-400 hover:text-indigo-300">
            Talk to us
          </a>
          .
        </p>
      </section>

      <SiteFooter />
    </div>
  )
}
