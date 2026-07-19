import { Link } from 'react-router-dom'

const TEASERS: {
  name: string
  price: string
  priceNote?: string
  hook: string
  featured?: boolean
}[] = [
  {
    name: 'Free',
    price: '€0',
    priceNote: 'forever',
    hook: 'Unlimited tokens, fully self-hosted. Add single files by hand via your AI. Private, non-commercial use.',
  },
  {
    name: 'Business',
    price: '€29',
    priceNote: 'per user / month',
    hook: 'Connectors keep entire drives in sync — SharePoint, Google Drive, OneDrive & more, refreshed automatically.',
    featured: true,
  },
  {
    name: 'Individual',
    price: "Let's talk",
    hook: 'Tailored cloud deployment — managed by us or in your cloud — plus custom integrations and SLAs.',
  },
]

/** Compact tier cards on the landing page; the full breakdown lives at /pricing. */
export function PricingTeaserSection() {
  return (
    <section className="relative bg-[#020617] px-6 py-28">
      <div className="mx-auto max-w-5xl">
        <div className="mb-14 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">Pricing</p>
          <h2 className="text-4xl font-bold text-white">Unlimited tokens on every plan.</h2>
          <p className="mx-auto mt-4 max-w-xl text-slate-400">
            Inference runs on your own hardware, so we never meter usage. Plans differ in how your
            knowledge gets in — not in how much you can use it.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {TEASERS.map((t, i) => (
            <div
              key={t.name}
              className={`reveal reveal-delay-${i + 1} flex flex-col rounded-2xl border p-6 backdrop-blur-sm ${
                t.featured
                  ? 'border-indigo-400/40 bg-indigo-500/[0.07]'
                  : 'border-slate-800 bg-slate-900/40'
              }`}
            >
              <h3 className="text-lg font-bold text-white">{t.name}</h3>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-bold text-white">{t.price}</span>
                {t.priceNote && <span className="text-xs text-slate-500">{t.priceNote}</span>}
              </div>
              <p className="mt-4 flex-1 text-sm leading-relaxed text-slate-400">{t.hook}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 text-center reveal">
          <Link to="/pricing" className="btn-cta-secondary" data-umami-event="landing_pricing_teaser">
            Compare plans →
          </Link>
        </div>
      </div>
    </section>
  )
}
