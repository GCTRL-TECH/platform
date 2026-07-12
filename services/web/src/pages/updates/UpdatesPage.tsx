/**
 * Public Update History — the maintenance-transparency page.
 *
 * Renders src/data/updates.json (newest first) as a versioned timeline so
 * anyone (no login needed) can see that GCTRL is actively maintained and what
 * each release added. Entries are authored by the GCTRL team; the post-release
 * routine (bench/release/publish_update.py) drafts new entries from a passing
 * shipping test, a human commits them with the release.
 */
import updates from '@/data/updates.json'

interface UpdateEntry {
  version: string
  date: string
  title: string
  author: string
  authorUrl: string
  sha?: string
  draft?: boolean
  highlights: string[]
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })
  } catch {
    return iso
  }
}

export function UpdatesPage() {
  // Auto-drafted entries (from the release post-routine) are hidden from the
  // public page until an author polishes them and removes the draft flag.
  const entries = (updates as UpdateEntry[]).filter(e => !e.draft)

  return (
    <div className="min-h-screen bg-background text-slate-200">
      <div className="mx-auto max-w-3xl px-5 py-14">
        <header className="mb-10">
          <a href="/" className="text-xs text-slate-500 hover:text-slate-300">← GCTRL</a>
          <h1 className="mt-3 text-3xl font-semibold text-slate-100">Update-Verlauf</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            Was in jeder GCTRL-Version dazugekommen ist. Wir machen unsere Verbesserungen transparent —
            damit du siehst, dass die Plattform aktiv gepflegt und weiterentwickelt wird.
          </p>
        </header>

        <ol className="relative border-l border-slate-800">
          {entries.map(e => (
            <li key={e.version} className="mb-10 ml-6">
              <span className="absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-primary bg-background" />
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="rounded-md bg-surface px-2 py-0.5 font-mono text-xs text-primary">v{e.version}</span>
                <h2 className="text-lg font-medium text-slate-100">{e.title}</h2>
                <time className="text-xs text-slate-500">{formatDate(e.date)}</time>
              </div>

              <ul className="mt-3 space-y-2">
                {e.highlights.map((h, i) => (
                  <li key={i} className="flex gap-2 text-sm leading-relaxed text-slate-300">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-3 text-xs text-slate-500">
                <a
                  href={e.authorUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-slate-400 hover:text-primary hover:underline"
                >
                  {e.author}
                </a>
                {e.sha ? <span className="ml-2 font-mono text-slate-600">#{e.sha}</span> : null}
              </div>
            </li>
          ))}
        </ol>

        <footer className="mt-6 border-t border-slate-800 pt-6 text-xs text-slate-600">
          GCTRL — Knowledge Extraction, Fusion & Talk-to-Graph. Gepflegt vom GCTRL-Team.
        </footer>
      </div>
    </div>
  )
}
