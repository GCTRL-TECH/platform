import type { Lang, Tree } from '../parser.js';
import type { SymbolKind } from '../types.js';

export interface RawSymbol {
  kind: Exclude<SymbolKind, 'file' | 'module'>;
  qualname: string;
  name: string;
  line_start: number;
  line_end: number;
  signature: string;
  doc: string;
  exported: boolean;
  /** qualname of enclosing class, for methods */
  parent?: string;
}

export interface RawImport {
  /** as written, e.g. 'pkg.a' | './util' | 'crate::x::y' */
  module: string;
  /** imported identifiers; ['*'] for star; [] for bare import */
  names: string[];
  /** `import x as y` / `import * as ns` */
  alias?: string;
  /** python dots */
  relativeLevel?: number;
  line: number;
}

export interface RawCall {
  /** last identifier */
  callee: string;
  /** `self`, `this`, `obj`, `mod` or undefined */
  receiver?: string;
  /** qualname of the enclosing def */
  inside?: string;
  line: number;
}

export interface RawInherit {
  /** qualname */
  child: string;
  /** as written */
  parent: string;
  kind: 'INHERITS' | 'IMPLEMENTS';
}

/** A local-variable binding to a constructed instance, e.g. `x = Thing()` / `let x = Name::new()`. */
export interface RawAssign {
  /** the bound identifier */
  name: string;
  /** last-segment of the constructor callee (`Thing`, `Engine`, `Name`) */
  ctor: string;
  /** qualname of the enclosing def, or undefined at module/top level */
  inside?: string;
  line: number;
}

export interface Extracted {
  symbols: RawSymbol[];
  imports: RawImport[];
  calls: RawCall[];
  inherits: RawInherit[];
  assigns: RawAssign[];
}

export interface LanguageExtractor {
  lang: Lang;
  extract(tree: Tree, source: string): Extracted;
}
