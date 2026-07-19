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
    tagline: 'Own your data. No lock-in, no token choke.',
    price: '€0',
    priceNote: 'forever',
    cta: { label: 'Get started free', href: '/register', event: 'pricing_free' },
    features: [
      'Unlimited tokens - inference runs on your hardware. No metering, no token choke.',
      'No vendor lock-in - your graph, your files, your models. Export or walk away anytime.',
      'Own your data - 100% local & self-hosted, GDPR by design.',
      'All four modules - KEX, FUSE, Knowledge Graphs, Talk to Graph',
      'Wiki-LLM - one federated wiki over all your graphs: entity & concept pages, backlinks, a live index and changelog. Auto-distilled locally, grounded in the graph.',
      'MCP gateway - Claude Code, Codex, Cursor & any MCP client',
      'One full-access access token - scoped colleague tokens are a Business feature',
    ],
    foot: 'Non-commercial, private use only.',
  },
  {
    name: 'Business',
    tagline: 'One access token per colleague - you decide what each one can see.',
    price: '€29',
    priceNote: 'per user - one scoped access token / month · billed monthly',
    featured: true,
    badge: 'Most popular',
    cta: { label: 'Get in touch', href: `${CONTACT}?subject=GCTRL%20Business`, event: 'pricing_business' },
    features: [
      'Everything in Free - licensed for commercial use',
      'Scoped colleague tokens - one per seat. Pick exactly which knowledge bases and which classification level each token can reach.',
      "Structure your company's knowledge by access - airtight project isolation, nothing mixes even by accident",
      'Revoke or expire any token instantly - access ends the moment someone leaves',
      'Connectors: continuously sync entire drives - SharePoint, Google Drive, OneDrive, Confluence & more',
      'Scheduled refresh & incremental re-sync - your graph stays current on its own',
      'Priority support',
    ],
    foot: 'Unlimited inference tokens included - no usage metering, ever.',
  },
  {
    name: 'Individual',
    tagline: 'Tailored deployment for your organization.',
    price: "Let's talk",
    priceNote: 'custom',
    cta: { label: 'Reach out to us', href: `${CONTACT}?subject=GCTRL%20Individual`, event: 'pricing_individual' },
    features: [
      'Everything in Business',
      'Cloud deployment - managed by us, or in your own cloud',
      'Custom integrations & connectors built for your stack',
      'On-prem / air-gapped & sovereign deployment',
      'TISAX & ISO 27001-aware hardening, SSO / SCIM',
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
        title="Pricing - GCTRL"
        description="Unlimited tokens on every plan - inference runs on your own hardware, so we never meter you. Free forever for private use: own your data, no vendor lock-in, plus a federated Wiki-LLM over your graphs. Business is one scoped access token per colleague, so you structure company knowledge by who may see what."
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
            <span className="font-semibold text-slate-200">Unlimited tokens on every plan</span> - inference
            runs on your own hardware, so we never meter your usage. Free gives you the whole platform for
            yourself. You pay only when knowledge has to reach{' '}
            <span className="font-semibold text-slate-200">other people</span> - one scoped access token per
            colleague.
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

        <div className="mx-auto mt-14 max-w-3xl rounded-2xl border border-slate-800 bg-slate-900/40 px-8 py-6 text-center backdrop-blur-sm">
          <p className="text-base font-semibold text-white">
            Unlimited tokens. On every plan. Really.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            Cloud memory platforms charge per million tokens processed. GCTRL runs inference on your own
            infrastructure, so there is nothing to meter - extract, fuse and chat as much as your hardware
            can handle. Fully self-hosted, DSGVO/GDPR by design.
          </p>
        </div>

        {/* What a "user" actually is - the Business story. Deliberately contrasts
            the two senses of "token" the page uses, so they never blur. */}
        <div className="mx-auto mt-6 max-w-3xl rounded-2xl border border-indigo-500/20 bg-indigo-500/[0.06] px-8 py-6 text-center backdrop-blur-sm">
          <p className="text-base font-semibold text-white">One seat = one access token.</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            On Business, a &ldquo;user&rdquo; is an <span className="font-medium text-slate-200">access
            token</span> you issue. As admin you create one scoped token per colleague and grant it exactly
            the knowledge bases it may reach, at the classification level you choose - that is how you
            structure your company&apos;s knowledge. Nothing outside a token&apos;s scope is visible to it,
            and you can revoke or expire any token instantly.
          </p>
          <p className="mt-3 text-xs text-slate-500">
            Not to be confused with the tokens above: those are inference units, and they stay unlimited.
            Free includes one full-access token for yourself.
          </p>
        </div>

        <p className="mx-auto mt-10 max-w-2xl text-center text-sm text-slate-500">
          Questions about licensing or volume?{' '}
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
