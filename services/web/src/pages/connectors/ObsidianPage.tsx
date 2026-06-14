import ObsidianVaultManager from '@/components/connectors/ObsidianVaultManager'

export default function ObsidianPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div>
        <h1 className="text-xl font-bold text-slate-100">Obsidian Vaults</h1>
        <p className="mt-1 text-xs text-slate-500">
          Add your Obsidian vaults here, then extract them from{' '}
          <span className="text-slate-400">KEX → Sources → Obsidian</span>.
        </p>
      </div>
      <ObsidianVaultManager />
    </div>
  )
}
