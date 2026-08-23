import fs from 'node:fs';
import path from 'node:path';

/**
 * Parsed `compilerOptions.baseUrl`/`paths` from the nearest tsconfig.json above a
 * TS/JS import site, used to resolve non-relative specifiers like `@/hooks/useApi`
 * to a repo file (mirrors what the TS compiler itself does, minus project references
 * and multi-level `extends` chains - see resolveNearestTsconfig below).
 */
export interface TsPathsConfig {
  /** absolute, native-separator directory containing the tsconfig.json */
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

function buildConfig(absConfigPath: string): TsPathsConfig | null {
  if (parsedConfigCache.has(absConfigPath)) return parsedConfigCache.get(absConfigPath)!;
  const json = readTsconfigJson(absConfigPath);
  if (!json) { parsedConfigCache.set(absConfigPath, null); return null; }
  let co = json.compilerOptions ?? {};
  // Single-level `extends`: only a relative path is worth following cheaply (a package
  // name like "@tsconfig/node20" would need node resolution - not worth it here). No
  // recursion into the parent's own `extends`.
  if (!co.baseUrl && !co.paths && typeof json.extends === 'string' && json.extends.startsWith('.')) {
    const parentAbs = path.resolve(path.dirname(absConfigPath), json.extends);
    const parentPath = parentAbs.endsWith('.json') ? parentAbs : `${parentAbs}.json`;
    const parentJson = readTsconfigJson(parentPath);
    if (parentJson?.compilerOptions) co = parentJson.compilerOptions;
  }
  if (!co.baseUrl && !co.paths) { parsedConfigCache.set(absConfigPath, null); return null; }
  const configDir = path.dirname(absConfigPath);
  const baseUrl = co.baseUrl ? path.resolve(configDir, co.baseUrl) : null;
  const paths: TsPathsConfig['paths'] = [];
  if (co.paths) {
    for (const [pattern, targets] of Object.entries(co.paths)) {
      const star = pattern.indexOf('*');
      paths.push(star >= 0
        ? { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), star: true, targets }
        : { prefix: pattern, suffix: '', star: false, targets });
    }
    paths.sort((a, b) => b.prefix.length - a.prefix.length); // longest (most specific) prefix wins
  }
  const result: TsPathsConfig = { configDir, baseUrl, paths };
  parsedConfigCache.set(absConfigPath, result);
  return result;
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
