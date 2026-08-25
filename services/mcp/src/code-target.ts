/**
 * Where `gctrl_code_index` puts a repository when the caller passes no `compilationId`.
 *
 * The server's own default for a CODE compilation is `Users/<owner>/Code` — right for a
 * single-user install, wrong on a shared instance where every colleague's token hangs off
 * the same GCTRL account: their code graphs would all pile into the OWNER's folder. The
 * host that launches this server (Anvil per session, a CI job per repo) knows the user's
 * place in the folder tree, so it pins the target through the environment instead of
 * trusting every agent to pass the id:
 *
 *   GCTRL_CODE_COMPILATION_ID   index into exactly this CODE compilation (project sessions:
 *                               one project = one repo = one code graph)
 *   GCTRL_CODE_FOLDER           "Users/<name>/Code" — auto-create "<repo> (code)" HERE
 *                               (personal sessions: one graph per repo, filed by user)
 *
 * An explicit `compilationId` from the caller always wins; the env is the default, not a
 * cage. Pure and dependency-free so it can be unit-tested without the MCP runtime.
 */
export interface CodeIndexTarget {
  compilationId?: string;
  /** Folder segments for the auto-created compilation, e.g. ["Users","fabio","Code"]. */
  folderPath?: string[];
}

export function codeIndexTarget(
  explicitCompilationId: string | undefined,
  env: Record<string, string | undefined>,
): CodeIndexTarget {
  const id = (explicitCompilationId ?? env['GCTRL_CODE_COMPILATION_ID'] ?? '').trim();
  if (id) return { compilationId: id };
  const folderPath = (env['GCTRL_CODE_FOLDER'] ?? '')
    .split('/')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return folderPath.length ? { folderPath } : {};
}
