import fs from 'node:fs';
import path from 'node:path';

/**
 * Parsed `compilerOptions.baseUrl`/`paths` from the nearest tsconfig.json above a
 * TS/JS import site, used to resolve non-relative specifiers like `@/hooks/useApi`
 * to a repo file (mirrors what the TS compiler itself does, minus project references
 * and multi-level `extends` chains - see resolveNearestTsconfig below).
 */
export interface TsPathsConfig {
  /** absolute, native-separator base for `paths` targets when `baseUrl` is unset: the
   * directory of the tsconfig that DECLARED `paths` (which may be an `extends` parent,
   * several directories up), matching TS 4.1+ semantics. */
  configDir: string;
  /** absolute, native-separator baseUrl dir, or null when compilerOptions.baseUrl is unset */
  baseUrl: string | null;
  /** compilerOptions.paths patterns, longest prefix first so the most specific match wins */
  paths: Array<{ prefix: string; suffix: string; star: boolean; targets: string[] }>;
}

interface RawTsconfig {
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
  extends?: string;
}

// tsconfig.json absolute path -> parsed+resolved config (or null if missing/unparseable).
const parsedConfigCache = new Map<string, TsPathsConfig | null>();
// starting directory (absolute, native) -> nearest resolved config found by walking up
// from it to the repo root (or null if none found). Keyed per starting directory so
// every file in the same directory reuses one lookup instead of re-walking the tree.
const nearestConfigCache = new Map<string, TsPathsConfig | null>();

/**
 * Strips `//` line comments and `/* *\/` block comments from JSONC (tsconfig files
 * commonly aren't strict JSON), staying string-aware so `"http://x"` survives. Good
 * enough for tsconfig - not a general JS tokenizer.
 */
function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  let strChar = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const c2 = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += c2 ?? ''; i++; continue; }
      if (c === strChar) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strChar = c; out += c; continue; }
    if (c === '/' && c2 === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

function readTsconfigJson(absPath: string): RawTsconfig | null {
  let raw: string;
  try { raw = fs.readFileSync(absPath, 'utf8'); } catch { return null; }
  try { return JSON.parse(stripTrailingCommas(stripJsonComments(raw))); } catch { return null; }
}

/** `baseUrl`/`paths` as declared by ONE tsconfig in the extends chain, each carrying the
 * directory of the file that declared it - TS resolves both relative to the declaring
 * config, so a `baseUrl` inherited from `../../tsconfig.base.json` must resolve against
 * THAT file's directory, not the child's. */
interface DeclaredOptions {
  baseUrl?: { value: string; dir: string };
  paths?: { value: Record<string, string[]>; dir: string };
}

/** Resolve one config's own `compilerOptions.baseUrl`/`paths` plus everything it inherits
 * through relative `extends`, child overriding parent PER KEY (a child that declares only
 * `paths` still inherits the parent's `baseUrl`). Only relative `extends` targets are
 * followed - a package name like "@tsconfig/node20" would need node resolution and never
 * carries baseUrl/paths worth resolving. `seen` breaks extends cycles. */
function declaredOptions(absConfigPath: string, seen: Set<string>): DeclaredOptions {
  if (seen.has(absConfigPath)) return {};
  seen.add(absConfigPath);
  const json = readTsconfigJson(absConfigPath);
  if (!json) return {};
  const dir = path.dirname(absConfigPath);
  let inherited: DeclaredOptions = {};
  if (typeof json.extends === 'string' && json.extends.startsWith('.')) {
    const parentAbs = path.resolve(dir, json.extends);
    const parentPath = parentAbs.endsWith('.json') ? parentAbs : `${parentAbs}.json`;
    inherited = declaredOptions(parentPath, seen);
  }
  const co = json.compilerOptions ?? {};
  const own: DeclaredOptions = { ...inherited };
  if (co.baseUrl) own.baseUrl = { value: co.baseUrl, dir };
  if (co.paths) own.paths = { value: co.paths, dir };
  return own;
}

function buildConfig(absConfigPath: string): TsPathsConfig | null {
  if (parsedConfigCache.has(absConfigPath)) return parsedConfigCache.get(absConfigPath)!;
  const declared = declaredOptions(absConfigPath, new Set());
  if (!declared.baseUrl && !declared.paths) { parsedConfigCache.set(absConfigPath, null); return null; }
  const configDir = path.dirname(absConfigPath);
  const baseUrl = declared.baseUrl ? path.resolve(declared.baseUrl.dir, declared.baseUrl.value) : null;
  const paths: TsPathsConfig['paths'] = [];
  if (declared.paths) {
    for (const [pattern, targets] of Object.entries(declared.paths.value)) {
      const star = pattern.indexOf('*');
      paths.push(star >= 0
        ? { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), star: true, targets }
        : { prefix: pattern, suffix: '', star: false, targets });
    }
    paths.sort((a, b) => b.prefix.length - a.prefix.length); // longest (most specific) prefix wins
  }
  // `paths` targets are relative to baseUrl when set, else to the config that DECLARED them.
  const result: TsPathsConfig = { configDir: declared.paths?.dir ?? configDir, baseUrl, paths };
  parsedConfigCache.set(absConfigPath, result);
  return result;
}

/** Drop both tsconfig caches. Called at the start of every `indexRepo` run so a long-lived
 * process (MCP server, watch mode) never resolves imports against a stale tsconfig. */
export function clearTsconfigCache(): void {
  parsedConfigCache.clear();
  nearestConfigCache.clear();
}

/** Walk up from `startDirAbs` to `repoRootAbs` (inclusive) looking for a tsconfig.json. */
export function findNearestTsconfig(startDirAbs: string, repoRootAbs: string): TsPathsConfig | null {
  const key = `${startDirAbs}|${repoRootAbs}`;
  const cached = nearestConfigCache.get(key);
  if (cached !== undefined) return cached;
  const root = path.resolve(repoRootAbs);
  let dir = path.resolve(startDirAbs);
  let result: TsPathsConfig | null = null;
  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      result = buildConfig(candidate);
      if (result) break;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root, nowhere left to go
    dir = parent;
  }
  nearestConfigCache.set(key, result);
  return result;
}

/**
 * Maps a non-relative import specifier through a resolved tsconfig's `paths` patterns
 * (longest prefix first) and, failing that, its `baseUrl`. Returns absolute,
 * native-separator, extension-less candidate paths in priority order.
 */
export function mapSpecifierViaConfig(cfg: TsPathsConfig, specifier: string): string[] {
  const candidates: string[] = [];
  const pathsBase = cfg.baseUrl ?? cfg.configDir;
  for (const p of cfg.paths) {
    let middle: string | null = null;
    if (p.star) {
      if (specifier.startsWith(p.prefix) && specifier.endsWith(p.suffix) && specifier.length >= p.prefix.length + p.suffix.length) {
        middle = specifier.slice(p.prefix.length, specifier.length - p.suffix.length);
      }
    } else if (specifier === p.prefix) {
      middle = '';
    }
    if (middle === null) continue;
    for (const target of p.targets) {
      const star = target.indexOf('*');
      const mapped = star >= 0 ? target.slice(0, star) + middle + target.slice(star + 1) : target;
      candidates.push(path.resolve(pathsBase, mapped));
    }
  }
  if (cfg.baseUrl) candidates.push(path.resolve(cfg.baseUrl, specifier));
  return candidates;
}
