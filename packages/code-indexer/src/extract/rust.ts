import type { SyntaxNode, Tree } from '../parser.js';
import type { Extracted, LanguageExtractor, RawCall, RawImport, RawInherit, RawSymbol } from './types.js';
import { firstLine, walk } from './engine.js';

function text(src: string, n: SyntaxNode | null): string { return n ? src.slice(n.startIndex, n.endIndex) : ''; }
function isPub(node: SyntaxNode): boolean { return node.namedChildren.some(c => c?.type === 'visibility_modifier'); }

function implTarget(node: SyntaxNode, src: string): { self?: string; trait?: string } | null {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'impl_item') {
      const ty = cur.childForFieldName('type'); const tr = cur.childForFieldName('trait');
      return { self: text(src, ty).replace(/<.*$/, ''), trait: tr ? text(src, tr).replace(/<.*$/, '') : undefined };
    }
    cur = cur.parent;
  }
  return null;
}

function enclosingFn(node: SyntaxNode, src: string): string | undefined {
  let cur = node.parent;
  while (cur) {
    if (cur.type === 'function_item') {
      const n = text(src, cur.childForFieldName('name'));
      const impl = implTarget(cur, src);
      return impl?.self ? `${impl.self}.${n}` : n;
    }
    cur = cur.parent;
  }
  return undefined;
}

function docComment(node: SyntaxNode, src: string): string {
  const prev = node.previousNamedSibling;
  if (prev?.type === 'line_comment' && text(src, prev).startsWith('///')) return text(src, prev).replace(/^\/\/\/\s?/, '').trim().slice(0, 300);
  return '';
}

export const rustExtractor: LanguageExtractor = {
  lang: 'rust',
  extract(tree: Tree, src: string): Extracted {
    const symbols: RawSymbol[] = []; const imports: RawImport[] = []; const calls: RawCall[] = []; const inherits: RawInherit[] = [];
    for (const node of walk(tree.rootNode)) {
      switch (node.type) {
        case 'function_item': {
          const name = text(src, node.childForFieldName('name'));
          const impl = implTarget(node, src);
          const qualname = impl?.self ? `${impl.self}.${name}` : name;
          symbols.push({ kind: impl ? 'method' : 'function', qualname, name,
            line_start: node.startPosition.row + 1, line_end: node.endPosition.row + 1,
            signature: firstLine(src, node).replace(/\s*\{?\s*$/, ''), doc: docComment(node, src),
            exported: isPub(node) || (!!impl?.trait), parent: impl?.self });
          break;
        }
        case 'struct_item': case 'enum_item': case 'trait_item': case 'type_item': {
          const name = text(src, node.childForFieldName('name'));
          const kind = node.type === 'struct_item' ? 'struct' : node.type === 'enum_item' ? 'enum' : node.type === 'trait_item' ? 'interface' : 'type';
          symbols.push({ kind, qualname: name, name, line_start: node.startPosition.row + 1, line_end: node.endPosition.row + 1,
            signature: firstLine(src, node).replace(/\s*\{?\s*$/, ''), doc: docComment(node, src), exported: isPub(node) });
          break;
        }
        case 'impl_item': {
          const ty = text(src, node.childForFieldName('type')).replace(/<.*$/, ''); const tr = node.childForFieldName('trait');
          if (tr) inherits.push({ child: ty, parent: text(src, tr).replace(/<.*$/, ''), kind: 'IMPLEMENTS' });
          break;
        }
        case 'mod_item': {
          const name = text(src, node.childForFieldName('name'));
          if (!node.childForFieldName('body')) imports.push({ module: name, names: [], alias: 'mod', line: node.startPosition.row + 1 }); // `mod foo;` -> file
          break;
        }
        case 'use_declaration': {
          const arg = node.childForFieldName('argument') ?? node.namedChildren[node.namedChildCount - 1] ?? null;
          const full = text(src, arg).replace(/\s+/g, '');
          // a::b::{c, d} | a::b::c | a::b::* | a::b as x
          const m = full.match(/^(.*?)::\{(.*)\}$/);
          if (m) imports.push({ module: m[1], names: m[2].split(',').map(s => s.replace(/as.*$/, '').trim()).filter(Boolean), line: node.startPosition.row + 1 });
          else {
            const parts = full.replace(/as\w+$/, '').split('::');
            const last = parts.pop() ?? '';
            imports.push({ module: parts.join('::'), names: last === '*' ? ['*'] : [last], line: node.startPosition.row + 1 });
          }
          break;
        }
        case 'call_expression': {
          const fn = node.childForFieldName('function'); if (!fn) break;
          const inside = enclosingFn(node, src);
          if (fn.type === 'identifier') calls.push({ callee: text(src, fn), inside, line: node.startPosition.row + 1 });
          else if (fn.type === 'field_expression') calls.push({ callee: text(src, fn.childForFieldName('field')), receiver: text(src, fn.childForFieldName('value')), inside, line: node.startPosition.row + 1 });
          else if (fn.type === 'scoped_identifier') { const p = text(src, fn.childForFieldName('path')); calls.push({ callee: text(src, fn.childForFieldName('name')), receiver: p.split('::').pop(), inside, line: node.startPosition.row + 1 }); }
          break;
        }
      }
    }
    return { symbols, imports, calls, inherits };
  },
};
