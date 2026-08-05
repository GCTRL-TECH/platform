import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Check, Minus } from 'lucide-react'
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
      'Unlimited tokens - inference runs on your hardware. No metering, no token choke, ever.',
      'All four modules - KEX, FUSE, Knowledge Graphs, Talk to Graph',
      'Wiki-LLM - one federated wiki over all your graphs: entity & concept pages, backlinks, a live index and changelog. Auto-distilled locally, grounded in the graph.',
      'MCP gateway - Claude Code, Codex, Cursor & any MCP client',
      'No vendor lock-in - your graph, your files, your models. Export or walk away anytime.',
      'Own your data - 100% local & self-hosted, GDPR by design.',
      '1 full-access token - the whole platform, for yourself. Colleague tokens and the compliance suite are Business features.',
      'Single-file manual ingest - add documents by hand via your AI. Connectors are a Business feature.',
    ],
    foot: 'Non-commercial, private use only.',
  },
  {
    name: 'Business',
    tagline: 'Ten colleague tokens per license - you decide what each one can see.',
    price: '€29',
    priceNote: 'per license / month · includes 10 colleague tokens',
    featured: true,
    badge: 'Most popular',
    cta: { label: 'Get in touch', href: `${CONTACT}?subject=GCTRL%20Business`, event: 'pricing_business' },
    features: [
      'Everything in Free - licensed for commercial use',
      '10 scoped colleague tokens per license - stack licenses as your team grows',
      'KB-scoped access - pick exactly which knowledge bases each token can reach',
      'Clearance enforcement - PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED, checked on every read',
      'Revoke or expire any token instantly - access ends the moment someone leaves',
      'Audit trail - who reached what, and when',
      'Connectors: continuously sync entire drives - SharePoint, Google Drive, OneDrive, Confluence & more',
      'Scheduled refresh & incremental re-sync - your graph stays current on its own',
      'Priority support',
    ],
    foot: 'Unlimited inference tokens included - no usage metering, ever.',
  },
  {
    name: 'Enterprise',
    tagline: 'Sovereign deployment at scale, with the support to match.',
    price: '€25,000',
    priceNote: 'per year · 100 seats included',
    cta: { label: 'Reach out to us', href: `${CONTACT}?subject=GCTRL%20Enterprise`, event: 'pricing_enterprise' },
    features: [
      'Everything in Business - for your whole organization',
      '100 seats included - additional seats individually priced',
      'Deployment your way - managed cloud, your cloud, on-prem, air-gapped or sovereign',
      'Custom integrations & connectors built for your stack',
      'TISAX & ISO 27001-aware hardening, security reviews',
      'SSO / SCIM',
      'Premium support & SLAs',
    ],
    foot: 'Unlimited inference tokens, of course - seats scale, usage never meters.',
  },
]

type MatrixCell = true | false | string
type MatrixRow = { label: string; values: [MatrixCell, MatrixCell, MatrixCell] }
type MatrixGroup = { title: string; rows: MatrixRow[] }

const MATRIX: MatrixGroup[] = [
  {
    title: 'Platform & Modules',
    rows: [
      { label: 'Inference tokens (extract, fuse, chat)', values: ['Unlimited', 'Unlimited', 'Unlimited'] },
      { label: 'All four modules - KEX, FUSE, Knowledge Graphs, Talk to Graph', values: [true, true, true] },
      { label: 'Wiki-LLM federated wiki', values: [true, true, true] },
      { label: 'MCP gateway - Claude Code, Codex, Cursor & any MCP client', values: [true, true, true] },
      { label: 'Cloaking for cloud models', values: [true, true, true] },
      { label: 'Commercial license', values: [false, true, true] },
    ],
  },
  {
    title: 'Ingestion & Connectors',
    rows: [
      { label: 'Single-file manual ingest', values: [true, true, true] },
      { label: 'Drive connectors - SharePoint, Google Drive, OneDrive, Confluence', values: [false, true, true] },
      { label: 'Scheduled refresh & incremental re-sync', values: [false, true, true] },
      { label: 'Custom connectors built for your stack', values: [false, false, true] },
    ],
  },
  {
    title: 'Access & Compliance',
    rows: [
      { label: 'Access tokens (seats)', values: ['1 full-access', '10 per license', '100 included'] },
      { label: 'KB-scoped colleague tokens', values: [false, true, true] },
      { label: 'Clearance enforcement - PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED', values: [false, true, true] },
      { label: 'Custom classification schemes', values: [false, true, true] },
      { label: 'Instant token revocation & expiry', values: [false, true, true] },
      { label: 'Audit trail', values: [false, true, true] },
      { label: 'SSO / SCIM', values: [false, false, true] },
      { label: 'Security reviews', values: [false, false, true] },
    ],
  },
  {
    title: 'Support & Deployment',
    rows: [
      { label: 'Self-hosted on your own hardware', values: [true, true, true] },
      { label: 'Managed cloud or deployment in your cloud', values: [false, false, true] },
      { label: 'Air-gapped & sovereign deployment', values: [false, false, true] },
      { label: 'TISAX & ISO 27001-aware hardening', values: [false, false, true] },
      { label: 'Support', values: ['Community', 'Priority', 'Premium + SLAs'] },
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

function MatrixValue({ value, highlight }: { value: MatrixCell; highlight?: boolean }) {
  if (value === true) return <Check size={16} className="text-indigo-400" aria-label="Included" />
  if (value === false) return <Minus size={16} className="text-slate-600" aria-label="Not included" />
  return (
    <span className={`text-[13px] font-medium ${highlight ? 'text-indigo-300' : 'text-slate-200'}`}>{value}</span>
  )
}

function ComparisonSection() {
  return (
    <div className="mx-auto mt-20 max-w-6xl">
      <div className="text-center">
        <span className="glass-pill mb-5">Compare plans</span>
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Every plan,{' '}
          <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
            side by side
          </span>
        </h2>
      </div>

      <div className="mt-10">
        {/* Sticky tier header - stays visible while scrolling the matrix */}
        <div className="sticky top-16 z-30 grid grid-cols-3 border-b border-slate-800 bg-[#020617]/95 backdrop-blur-sm lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
          <div className="hidden lg:block" />
          <div className="py-3 text-center text-sm font-semibold text-white">Free</div>
          <div className="py-3 text-center text-sm font-semibold text-indigo-300">Business</div>
          <div className="py-3 text-center text-sm font-semibold text-white">Enterprise</div>
        </div>

        {MATRIX.map((group) => (
          <div key={group.title}>
            <div className="pt-8 pb-2 text-xs font-semibold uppercase tracking-widest text-indigo-400">
              {group.title}
            </div>
            {group.rows.map((row) => (
              <div
                key={row.label}
                className="grid grid-cols-3 gap-x-2 border-b border-slate-800/60 py-3 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))] lg:items-center"
              >
                <div className="col-span-3 mb-2 text-sm leading-snug text-slate-300 lg:col-span-1 lg:mb-0 lg:pr-6">
                  {row.label}
                </div>
                {row.values.map((value, i) => (
                  <div
                    key={i}
                    className={`flex items-center justify-center text-center ${
                      i === 1 ? 'rounded-lg py-1 lg:bg-indigo-500/[0.05]' : 'py-1'
                    }`}
                  >
                    <MatrixValue value={value} highlight={row.label.startsWith('Inference tokens')} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>

      <p className="mx-auto mt-6 max-w-3xl text-center text-xs text-slate-500">
        Enterprise: seats beyond the included 100 are individually priced. Inference tokens are unlimited on
        every plan and never appear in this table as a limit - because there is none.
      </p>
    </div>
  )
}

const DEFINITIONS: { term: string; body: string }[] = [
  {
    term: 'Inference token',
    body: 'The unit cloud platforms meter - every word your models read or write. GCTRL runs inference on your own hardware, so these are never counted and never limited, on any plan. Extract, fuse and chat as much as your machines can handle.',
  },
  {
    term: 'Access token',
    body: 'A key you issue that lets one person or agent into your graphs. Free includes 1 full-access token for yourself. Business adds scoped colleague tokens: each one reaches only the knowledge bases you grant, at the clearance you set (PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED), and can be revoked instantly.',
  },
  {
    term: 'License',
    body: 'The Business billing unit. €29 / month buys one license with 10 colleague tokens included. Team grows past ten? Stack another license - they simply add up.',
  },
  {
    term: 'Seat',
    body: 'The Enterprise unit: one seat is one person with their own access token. €25,000 / year includes 100 seats; additional seats are individually priced.',
  },
]

function DefinitionsSection() {
  return (
    <div className="mx-auto mt-20 max-w-5xl">
      <div className="text-center">
        <span className="glass-pill mb-5">Definitions</span>
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          What counts as{' '}
          <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
            what
          </span>
        </h2>
      </div>

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        {DEFINITIONS.map((d) => (
          <div key={d.term} className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6 backdrop-blur-sm">
            <p className="text-base font-semibold text-white">{d.term}</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">{d.body}</p>
          </div>
        ))}
      </div>

      <p className="mx-auto mt-6 max-w-2xl text-center text-xs text-slate-500">
        Two meanings of &ldquo;token&rdquo;, never mixed: inference tokens stay unlimited everywhere. Plans
        differ only in access tokens and compliance.
      </p>
    </div>
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
        description="Unlimited tokens on every plan - inference runs on your own hardware, so we never meter you. Free forever for private use: the whole platform, one full-access token. Business is €29 per license / month with 10 scoped colleague tokens and the full compliance suite - clearance enforcement, instant revocation, audit trail, connectors. Enterprise is €25,000 / year with 100 seats, premium support and sovereign deployment."
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
            yourself. You pay when knowledge has to reach{' '}
            <span className="font-semibold text-slate-200">other people</span> - scoped access for every
            colleague, clearance enforcement, and an audit trail to prove it.
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
            Cloud memory platforms hand you your first million tokens free, then meter every million after
            that at around $2.50 - the bill grows with every document you process and every question you ask.
            GCTRL runs inference on your own infrastructure, so there is nothing to meter: extract, fuse and
            chat as much as your hardware can handle, on Free too. Fully self-hosted, DSGVO/GDPR by design.
          </p>
        </div>

        <ComparisonSection />

        <DefinitionsSection />

        <p className="mx-auto mt-16 max-w-2xl text-center text-sm text-slate-500">
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
