const INTEGRATIONS = [
  { name: 'Neo4j',         emoji: '🕸️', desc: 'Native KG storage'     },
  { name: 'Qdrant',        emoji: '🎯', desc: 'Vector RAG backend'    },
  { name: 'Google Drive',  emoji: '📁', desc: 'Cloud document source'  },
  { name: 'Microsoft 365', emoji: '📊', desc: 'Office & SharePoint'    },
  { name: 'Confluence',    emoji: '📝', desc: 'Wiki & documentation'   },
  { name: 'GitHub',        emoji: '🐙', desc: 'Code & docs'            },
  { name: 'Slack',         emoji: '💬', desc: 'Messages & threads'     },
  { name: 'REST API',      emoji: '🔌', desc: 'Any custom source'      },
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
              <span className="text-3xl">{int.emoji}</span>
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
