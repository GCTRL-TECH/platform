import { Plug2 } from 'lucide-react'

// simpleicons CDN supports a /COLOR suffix that recolours the SVG server-side,
// so we don't have to fake white-out with brightness-0/invert (which broke a
// couple of multi-fill icons like the old Microsoft tile).
const CDN = 'https://cdn.simpleicons.org'
const WHITE = 'FFFFFF'

const INTEGRATIONS = [
  { name: 'SharePoint',    logo: `${CDN}/microsoftsharepoint/${WHITE}`, desc: 'Enterprise docs'  },
  { name: 'Google Drive',  logo: `${CDN}/googledrive/${WHITE}`,  desc: 'Cloud document source' },
  { name: 'Confluence',    logo: `${CDN}/confluence/${WHITE}`,   desc: 'Wiki & documentation'  },
  { name: 'Notion',        logo: `${CDN}/notion/${WHITE}`,      desc: 'Workspace & docs'      },
  { name: 'GitHub',        logo: `${CDN}/github/${WHITE}`,       desc: 'Code & docs'           },
  { name: 'Obsidian',      logo: `${CDN}/obsidian/${WHITE}`,     desc: 'Knowledge vault'       },
  { name: 'Neo4j',         logo: `${CDN}/neo4j/${WHITE}`,        desc: 'Swappable KG store'    },
  { name: 'Qdrant',        logo: `${CDN}/qdrant/${WHITE}`,       desc: 'Swappable vector store'},
  { name: 'REST API',      logo: null,                            desc: 'Any custom source'     },
]

export function IntegrationsSection() {
  return (
    <section className="relative bg-gradient-to-b from-[#020617] to-[#0a0f24] px-6 py-28">
      <div className="mx-auto max-w-5xl">
        <div className="mb-16 text-center reveal">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-indigo-400">Integrations</p>
          <h2 className="text-4xl font-bold text-white">Connect your entire data estate.</h2>
          <p className="mx-auto mt-4 max-w-xl text-slate-400">
            Native connectors for the tools your teams already use. Replace the backend without changing the frontend.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {INTEGRATIONS.map((int, i) => (
            <div
              key={int.name}
              className={`reveal reveal-delay-${(i % 4) + 1} flex flex-col items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-5 text-center backdrop-blur-sm transition-all hover:border-indigo-500/30 hover:bg-slate-800/60`}
            >
              {int.logo
                ? <img src={int.logo} alt={int.name} width={32} height={32} className="w-8 h-8" loading="lazy" />
                : <Plug2 size={32} className="text-slate-400" />
              }
              <span className="text-sm font-semibold text-slate-200">{int.name}</span>
              <span className="text-[11px] text-slate-500">{int.desc}</span>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-sm text-slate-500 reveal">
          Plus REST API, webhooks, and a connector SDK for any custom source.
        </p>
      </div>
    </section>
  )
}
