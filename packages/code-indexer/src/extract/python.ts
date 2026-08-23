import type { SyntaxNode, Tree } from '../parser.js';
import type { Extracted, LanguageExtractor, RawAssign, RawCall, RawImport, RawInherit, RawSymbol } from './types.js';
import { firstLine, unquote, walk } from './engine.js';

/** `Name` in `x = Name(...)` or `x = mod.Name(...)`, from the call's `function` node — last segment, iff it starts uppercase. */
function ctorFromCallee(fn: SyntaxNode, src: string): string | null {
  let last: SyntaxNode | null = null;
  if (fn.type === 'identifier') last = fn;
  else if (fn.type === 'attribute') last = fn.childForFieldName('attribute');
  if (!last) return null;
  const name = src.slice(last.startIndex, last.endIndex);
  return /^[A-Z]/.test(name) ? name : null;
}

/**
 * True when walking up from `node` crosses a `lambda` before reaching the nearest
 * enclosing `function_definition`/`class_definition` or the module root. Unlike TS's
 * named arrow-consts, python has no equivalent "named lambda" exemption — a lambda
 * assigned to a variable (`cb = lambda: helper()`) is still anonymous.
 */
function crossesAnonymous(node: SyntaxNode): boolean {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'lambda') return true;
    if (cur.type === 'function_definition' || cur.type === 'class_definition') return false;
    cur = cur.parent;
  }
  return false;
}

function enclosingQualname(node: SyntaxNode, src: string): { qual: string; classQual?: string } {
  const parts: string[] = [];
  let classQual: string | undefined;
  let cur: SyntaxNode | null = node.parent;
  while (cur) {
    if (cur.type === 'function_definition' || cur.type === 'class_definition') {
      const n = cur.childForFieldName('name');
      if (n) parts.unshift(src.slice(n.startIndex, n.endIndex));
      if (cur.type === 'class_definition' && classQual === undefined) classQual = parts.join('.');
    }
    cur = cur.parent;
  }
  return { qual: parts.join('.'), classQual };
}

/** Recursively collect bound identifier names out of a parameter/assignment-target
 * pattern node into `out`: plain `identifier`; `pattern_list`/`tuple_pattern`/`list_pattern`
 * for unpacking (`a, b = ...`); `default_parameter`/`typed_parameter`/`typed_default_parameter`
 * for `x=1`/`x: T`/`x: T=1`; `list_splat_pattern`/`dictionary_splat_pattern` for `*args`/`**kw`;
 * `as_pattern_target` for `with ... as x`. */
function collectPatternNames(node: SyntaxNode, src: string, out: string[]): void {
  switch (node.type) {
    case 'identifier':
      out.push(src.slice(node.startIndex, node.endIndex));
      break;
    case 'pattern_list':
    case 'tuple_pattern':
    case 'list_pattern':
      for (let i = 0; i < node.namedChildCount; i++) collectPatternNames(node.namedChild(i)!, src, out);
      break;
    case 'default_parameter':
    case 'typed_parameter':
    case 'typed_default_parameter': {
      const n = node.childForFieldName('name') ?? node.namedChild(0);
      if (n) collectPatternNames(n, src, out);
      break;
    }
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern':
    case 'as_pattern_target': {
      const n = node.namedChild(0);
      if (n) collectPatternNames(n, src, out);
      break;
    }
    default:
      break;
  }
}

function docstring(defNode: SyntaxNode, src: string): string {
  const body = defNode.childForFieldName('body');
  const first = body?.namedChild(0);
  if (first?.type === 'expression_statement' && first.namedChild(0)?.type === 'string') {
    const s = unquote(src.slice(first.startIndex, first.endIndex));
    return s.split('\n')[0].trim().slice(0, 300);
  }
  return '';
}

export const pythonExtractor: LanguageExtractor = {
  lang: 'python',
  extract(tree: Tree, src: string): Extracted {
    const symbols: RawSymbol[] = [];
    const imports: RawImport[] = [];
    const calls: RawCall[] = [];
    const inherits: RawInherit[] = [];
    const assigns: RawAssign[] = [];
    const localsByScopeSets = new Map<string, Set<string>>();
    const addLocals = (scope: string, names: string[]) => {
      if (!names.length) return;
      const set = localsByScopeSets.get(scope) ?? new Set<string>();
      for (const n of names) set.add(n);
      localsByScopeSets.set(scope, set);
    };
    for (const node of walk(tree.rootNode)) {
      if (node.type === 'function_definition' || node.type === 'class_definition') {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const name = src.slice(nameNode.startIndex, nameNode.endIndex);
        const { qual: prefix, classQual } = enclosingQualname(node, src);
        const qualname = prefix ? `${prefix}.${name}` : name;
        // `decorated_definition` wraps a decorated def/class: `decorated_definition -> block -> class_definition`.
        // Look through it so a decorated method is still recognized as a method.
        const effectiveParent = node.parent?.type === 'decorated_definition' ? node.parent.parent : node.parent;
        const isMethod =
          node.type === 'function_definition' &&
          effectiveParent?.type === 'block' &&
          effectiveParent.parent?.type === 'class_definition';
        const sig = firstLine(src, node).replace(/:\s*$/, '');
        symbols.push({
          kind: node.type === 'class_definition' ? 'class' : isMethod ? 'method' : 'function',
          qualname,
          name,
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          signature: sig,
          doc: docstring(node, src),
          exported: !name.startsWith('_'),
          parent: isMethod ? classQual : undefined,
        });
        if (node.type === 'class_definition') {
          const sup = node.childForFieldName('superclasses');
          if (sup)
            for (let i = 0; i < sup.namedChildCount; i++) {
              const c = sup.namedChild(i)!;
              if (c.type === 'identifier' || c.type === 'attribute') {
                inherits.push({ child: qualname, parent: src.slice(c.startIndex, c.endIndex), kind: 'INHERITS' });
              }
            }
        }
      } else if (node.type === 'import_statement') {
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i)!;
          if (c.type === 'dotted_name')
            imports.push({ module: src.slice(c.startIndex, c.endIndex), names: [], line: node.startPosition.row + 1 });
          else if (c.type === 'aliased_import') {
            const n = c.childForFieldName('name');
            const a = c.childForFieldName('alias');
            if (n)
              imports.push({
                module: src.slice(n.startIndex, n.endIndex),
                names: [],
                alias: a ? src.slice(a.startIndex, a.endIndex) : undefined,
                line: node.startPosition.row + 1,
              });
          }
        }
      } else if (node.type === 'import_from_statement') {
        const modNode = node.childForFieldName('module_name');
        let module = modNode ? src.slice(modNode.startIndex, modNode.endIndex) : '';
        let level = 0;
        while (module.startsWith('.')) {
          level++;
          module = module.slice(1);
        }
        const names: string[] = [];
        const aliases: Record<string, string> = {};
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i)!;
          // web-tree-sitter returns a fresh wrapper object per accessor call, so
          // `c === modNode` never holds even for the same underlying node — compare
          // by the node's stable `id` instead.
          if (modNode && c.id === modNode.id) continue;
          if (c.type === 'dotted_name') names.push(src.slice(c.startIndex, c.endIndex));
          else if (c.type === 'aliased_import') {
            const n = c.childForFieldName('name');
            const a = c.childForFieldName('alias');
            if (n) {
              const original = src.slice(n.startIndex, n.endIndex);
              names.push(original);
              // `from x import a as b` — call sites write `b`, the target file defines `a`.
              if (a) aliases[src.slice(a.startIndex, a.endIndex)] = original;
            }
          } else if (c.type === 'wildcard_import') names.push('*');
        }
        imports.push({ module, names, aliases: Object.keys(aliases).length ? aliases : undefined, relativeLevel: level || undefined, line: node.startPosition.row + 1 });
      } else if (node.type === 'assignment') {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left?.type === 'identifier' && right?.type === 'call') {
          const fn = right.childForFieldName('function');
          const ctor = fn ? ctorFromCallee(fn, src) : null;
          if (ctor) {
            const { qual } = enclosingQualname(node, src);
            assigns.push({ name: src.slice(left.startIndex, left.endIndex), ctor, inside: qual || undefined, line: node.startPosition.row + 1 });
          }
        }
        // Every assignment target is a local binding in its enclosing scope (plain
        // identifier or `a, b = ...` unpacking), independent of the ctor-tracking above.
        if (left) {
          const names: string[] = [];
          collectPatternNames(left, src, names);
          const { qual } = enclosingQualname(node, src);
          addLocals(qual, names);
        }
      } else if (node.type === 'for_statement') {
        // `for k in y:` / `for k, v in items.items():` — loop target(s) are locals of
        // the enclosing function for the rest of that scope.
        const left = node.childForFieldName('left');
        if (left) {
          const names: string[] = [];
          collectPatternNames(left, src, names);
          const { qual } = enclosingQualname(node, src);
          addLocals(qual, names);
        }
      } else if (node.type === 'as_pattern') {
        // `with open(...) as fh:` — bind fh as a local of the enclosing scope.
        const alias = node.childForFieldName('alias');
        if (alias) {
          const names: string[] = [];
          collectPatternNames(alias, src, names);
          const { qual } = enclosingQualname(node, src);
          addLocals(qual, names);
        }
      } else if (node.type === 'parameters') {
        const { qual } = enclosingQualname(node, src);
        const names: string[] = [];
        for (let i = 0; i < node.namedChildCount; i++) collectPatternNames(node.namedChild(i)!, src, names);
        addLocals(qual, names);
      } else if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (!fn) continue;
        const { qual } = enclosingQualname(node, src);
        const anonymous = crossesAnonymous(node) || undefined;
        if (fn.type === 'identifier') {
          calls.push({ callee: src.slice(fn.startIndex, fn.endIndex), inside: qual || undefined, anonymous, line: node.startPosition.row + 1 });
        } else if (fn.type === 'attribute') {
          const attr = fn.childForFieldName('attribute');
          const obj = fn.childForFieldName('object');
          if (attr)
            calls.push({
              callee: src.slice(attr.startIndex, attr.endIndex),
              receiver: obj ? src.slice(obj.startIndex, obj.endIndex) : undefined,
              inside: qual || undefined,
              anonymous,
              line: node.startPosition.row + 1,
            });
        }
      }
    }
    const localsByScope: Record<string, string[]> = {};
    for (const [scope, names] of localsByScopeSets) localsByScope[scope] = [...names];
    return { symbols, imports, calls, inherits, assigns, localsByScope };
  },
};
