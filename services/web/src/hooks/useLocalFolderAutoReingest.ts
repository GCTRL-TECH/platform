import { useEffect } from 'react'
import { runAutoReingestSweep } from '@/lib/localFolders'

/**
 * App-level background sweep for "Local Folder" KEX sources. While GCTRL is open
 * in the browser, periodically re-ingests folders that have auto re-ingest on,
 * uploading only files whose name+mtime+size changed since the last run. Silent:
 * folders whose File System permission isn't granted in this session are skipped
 * until the user re-opens them (a browser restart resets the permission grant).
 *
 * Mounted once in the authenticated shell so it runs across all pages.
 */
export function useLocalFolderAutoReingest(intervalMs = 10 * 60 * 1000) {
  useEffect(() => {
    let cancelled = false
    const run = () => { if (!cancelled) void runAutoReingestSweep() }
    // First sweep shortly after load (let auth/permissions settle), then on a timer.
    const initial = setTimeout(run, 20_000)
    const iv = setInterval(run, intervalMs)
    return () => { cancelled = true; clearTimeout(initial); clearInterval(iv) }
  }, [intervalMs])
}
