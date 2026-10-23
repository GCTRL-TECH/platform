/**
 * Copy text to the clipboard - everywhere GCTRL runs.
 *
 * `navigator.clipboard` exists only in a secure context (https:// or
 * localhost). Customers open the console over plain http://<LAN-IP>:3001,
 * where the object is undefined and every direct `navigator.clipboard
 * .writeText(...)` threw before the "Copied" feedback could show - the
 * token and the "Connect your agent" snippet looked uncopyable. This helper
 * tries the async API first and falls back to the legacy selection +
 * `execCommand('copy')` path, which works on http and inside the click.
 *
 * Returns whether the text ended up on the clipboard.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to the legacy path (denied permission, lost gesture, ...)
    }
  }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  const selection = document.getSelection()
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  if (previous && selection) {
    selection.removeAllRanges()
    selection.addRange(previous)
  }
  return ok
}
