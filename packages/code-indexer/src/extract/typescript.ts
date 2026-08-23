import type { SyntaxNode, Tree } from '../parser.js';
import type { Extracted, LanguageExtractor, RawAssign, RawCall, RawImport, RawInherit, RawSymbol } from './types.js';
import { firstLine, walk } from './engine.js';

/** last segment of a `new_expression`'s constructor (identifier or member_expression). */
function ctorName(newExpr: SyntaxNode, src: string): string | null {
  const ctor = newExpr.childForFieldName('constructor');
  if (!ctor) return null;
  if (ctor.type === 'identifier') return text(src, ctor);
  if (ctor.type === 'member_expression') { const prop = ctor.childForFieldName('property'); return prop ? text(src, prop) : null; }
  return null;
}

const DEF_TYPES = new Set([
  'function_declaration', 'class_declaration', 'abstract_class_declaration', 'method_definition',
  'interface_declaration', 'enum_declaration', 'type_alias_declaration',
]);

function text(src: string, n: SyntaxNode | null): string {
  return n ? src.slice(n.startIndex, n.endIndex) : '';
}

/** Non-null named children — web-tree-sitter's `namedChildren` is typed `(Node | null)[]`. */
function namedChildren(n: SyntaxNode): SyntaxNode[] {
  return n.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

function isFnValue(declarator: SyntaxNode): boolean {
  const v = declarator.childForFieldName('value');
  return !!v && (v.type === 'arrow_function' || v.type === 'function_expression' || v.type === 'function');
}

function enclosing(node: SyntaxNode, src: string): { qual: string; classQual?: string } {
  const parts: string[] = [];
  let classQual: string | undefined;
  let cur = node.parent;
  while (cur) {
    if (DEF_TYPES.has(cur.type) || (cur.type === 'variable_declarator' && isFnValue(cur))) {
      const n = cur.childForFieldName('name');
      if (n) parts.unshift(text(src, n));
      if ((cur.type === 'class_declaration' || cur.type === 'abstract_class_declaration') && classQual === undefined) {
        classQual = parts.join('.');
      }
    }
    cur = cur.parent;
  }
  return { qual: parts.join('.'), classQual };
}

function isExported(node: SyntaxNode): boolean {
  let cur: SyntaxNode | null = node;
  for (let i = 0; i < 3 && cur; i++) {
    if (cur.type === 'export_statement') return true;
    cur = cur.parent;
  }
  return false;
}

/** First line of a JSDoc `/** ... *\/` comment immediately preceding `node`. */
function jsdoc(node: SyntaxNode, src: string): string {
  const prev = node.previousNamedSibling;
  if (prev?.type === 'comment' && src.slice(prev.startIndex, prev.startIndex + 3) === '/**') {
    return (
      text(src, prev)
        .replace(/^\/\*\*|\*\/$/g, '')
        .split('\n')
        .map(l => l.replace(/^\s*\*\s?/, '').trim())
        .filter(Boolean)[0] ?? ''
    );
  }
  return '';
}

export const tsExtractor: LanguageExtractor = {
  lang: 'typescript',
  extract(tree: Tree, src: string): Extracted {
    const symbols: RawSymbol[] = [];
    const imports: RawImport[] = [];
    const calls: RawCall[] = [];
    const inherits: RawInherit[] = [];
    const assigns: RawAssign[] = [];
    for (const node of walk(tree.rootNode)) {
      const isArrowConst = node.type === 'variable_declarator' && isFnValue(node);
      if (DEF_TYPES.has(node.type) || isArrowConst) {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const name = text(src, nameNode);
        const { qual: prefix, classQual } = enclosing(node, src);
        const qualname = prefix ? `${prefix}.${name}` : name;
        const kind: RawSymbol['kind'] =
          node.type === 'method_definition' ? 'method'
          : node.type.includes('class') ? 'class'
          : node.type === 'interface_declaration' ? 'interface'
          : node.type === 'enum_declaration' ? 'enum'
          : node.type === 'type_alias_declaration' ? 'type'
          : 'function';
        // For an arrow-const (`export const mul = (...) => ...`) the export wraps the
        // `lexical_declaration` that holds this `variable_declarator`, not the declarator itself.
        const exportRoot = isArrowConst ? (node.parent?.parent ?? node) : node;
        // Same detour for JSDoc: the comment sits before the `lexical_declaration`/`export_statement`,
        // not before the `variable_declarator`.
        const docNode = isArrowConst ? (node.parent ?? node) : node;
        const docSearchNode = docNode.parent?.type === 'export_statement' ? docNode.parent : docNode;
        symbols.push({
          kind,
          qualname,
          name,
          line_start: node.startPosition.row + 1,
          line_end: node.endPosition.row + 1,
          signature: firstLine(src, node).replace(/\s*\{?\s*$/, ''),
          doc: jsdoc(docSearchNode, src),
          exported: kind === 'method' ? !/\bprivate\b/.test(firstLine(src, node)) : isExported(exportRoot),
          parent: kind === 'method' ? classQual : undefined,
        });
        if (kind === 'class') {
          const heritage = namedChildren(node).find(c => c.type === 'class_heritage');
          if (heritage) {
            for (const clause of namedChildren(heritage)) {
              const k: RawInherit['kind'] = clause.type === 'implements_clause' ? 'IMPLEMENTS' : 'INHERITS';
              for (const t of namedChildren(clause)) {
                if (t.type === 'identifier' || t.type === 'type_identifier' || t.type === 'member_expression' || t.type === 'generic_type') {
                  inherits.push({ child: qualname, parent: text(src, t).replace(/<.*$/, ''), kind: k });
                }
              }
            }
          }
        }
      } else if (node.type === 'import_statement') {
        const srcNode = node.childForFieldName('source');
        const module = text(src, srcNode).replace(/^['"]|['"]$/g, '');
        const names: string[] = [];
        let alias: string | undefined;
        const clause = namedChildren(node).find(c => c.type === 'import_clause');
        if (clause) {
          for (const c of namedChildren(clause)) {
            if (c.type === 'identifier') {
              names.push('default');
              alias = text(src, c);
            } else if (c.type === 'namespace_import') {
              const ns = namedChildren(c)[0];
              if (ns) alias = text(src, ns);
            } else if (c.type === 'named_imports') {
              for (const spec of namedChildren(c)) {
                if (spec.type === 'import_specifier') names.push(text(src, spec.childForFieldName('name')));
              }
            }
          }
        }
        imports.push({ module, names, alias, line: node.startPosition.row + 1 });
      } else if (node.type === 'variable_declarator') {
        // `const|let|var x = new Name(...)`
        const nameNode = node.childForFieldName('name');
        const value = node.childForFieldName('value');
        if (nameNode?.type === 'identifier' && value?.type === 'new_expression') {
          const ctor = ctorName(value, src);
          if (ctor) { const { qual } = enclosing(node, src); assigns.push({ name: text(src, nameNode), ctor, inside: qual || undefined, line: node.startPosition.row + 1 }); }
        }
      } else if (node.type === 'assignment_expression') {
        // `x = new Name(...)` (no declaration keyword)
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left?.type === 'identifier' && right?.type === 'new_expression') {
          const ctor = ctorName(right, src);
          if (ctor) { const { qual } = enclosing(node, src); assigns.push({ name: text(src, left), ctor, inside: qual || undefined, line: node.startPosition.row + 1 }); }
        }
      } else if (node.type === 'call_expression' || node.type === 'new_expression') {
        const fn = node.childForFieldName(node.type === 'new_expression' ? 'constructor' : 'function');
        if (!fn) continue;
        const { qual } = enclosing(node, src);
        if (fn.type === 'identifier') {
          calls.push({ callee: text(src, fn), inside: qual || undefined, line: node.startPosition.row + 1 });
        } else if (fn.type === 'member_expression') {
          const prop = fn.childForFieldName('property');
          const obj = fn.childForFieldName('object');
          if (prop) {
            calls.push({
              callee: text(src, prop),
              receiver: obj ? text(src, obj) : undefined,
              inside: qual || undefined,
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }
    return { symbols, imports, calls, inherits, assigns };
  },
};
