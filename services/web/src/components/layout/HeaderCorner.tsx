import { usePublicConfig } from '@/hooks/usePublicConfig'
import { ReportBugButton } from '@/components/bugs/ReportBugButton'
import { cn } from '@/lib/utils'

/**
 * Always-visible platform version. The text is the API version from
 * `GET /config/public` (the version that is actually running); the tooltip adds
 * the web bundle's build marker and, when known, the license agent's version.
 */
export function VersionBadge({ agentVersion }: { agentVersion?: string }) {
  const config = usePublicConfig()
  const webVersion = (import.meta.env as Record<string, string | undefined>).VITE_BUILD_VERSION || 'dev'
  const platformVersion = config.version || webVersion
  const tooltip = [
    `GCTRL platform v${platformVersion}`,
    `web build ${webVersion}`,
    agentVersion ? `license agent v${agentVersion}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <span
      title={tooltip}
      className="select-none rounded-md border border-slate-800 px-2 py-0.5 font-mono text-[11px] leading-5 text-slate-500"
    >
      v{platformVersion}
    </span>
  )
}

/**
 * The top-right corner every page shares: version badge + "Report bug".
 * The AppShell header renders it; immersive pages that hide that header
 * (chat, graph workspace) drop it into their own toolbars so both elements
 * are reachable from literally every page.
 */
export function HeaderCorner({ agentVersion, className }: { agentVersion?: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <VersionBadge agentVersion={agentVersion} />
      <ReportBugButton />
    </div>
  )
}
