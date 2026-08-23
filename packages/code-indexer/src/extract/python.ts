import type { SyntaxNode, Tree } from '../parser.js';
import type { Extracted, LanguageExtractor, RawCall, RawImport, RawInherit, RawSymbol } from './types.js';
import { firstLine, unquote, walk } from './engine.js';

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
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i)!;
          // web-tree-sitter returns a fresh wrapper object per accessor call, so
          // `c === modNode` never holds even for the same underlying node — compare
          // by the node's stable `id` instead.
          if (modNode && c.id === modNode.id) continue;
          if (c.type === 'dotted_name') names.push(src.slice(c.startIndex, c.endIndex));
          else if (c.type === 'aliased_import') {
            const n = c.childForFieldName('name');
            if (n) names.push(src.slice(n.startIndex, n.endIndex));
          } else if (c.type === 'wildcard_import') names.push('*');
        }
        imports.push({ module, names, relativeLevel: level || undefined, line: node.startPosition.row + 1 });
      } else if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        if (!fn) continue;
        const { qual } = enclosingQualname(node, src);
        if (fn.type === 'identifier') {
          calls.push({ callee: src.slice(fn.startIndex, fn.endIndex), inside: qual || undefined, line: node.startPosition.row + 1 });
        } else if (fn.type === 'attribute') {
          const attr = fn.childForFieldName('attribute');
          const obj = fn.childForFieldName('object');
          if (attr)
            calls.push({
              callee: src.slice(attr.startIndex, attr.endIndex),
              receiver: obj ? src.slice(obj.startIndex, obj.endIndex) : undefined,
              inside: qual || undefined,
              line: node.startPosition.row + 1,
            });
        }
      }
    }
    return { symbols, imports, calls, inherits };
  },
};
