import type { SyntaxNode, Tree } from '../parser.js';
import type { Extracted, LanguageExtractor, RawAssign, RawCall, RawImport, RawInherit, RawSymbol } from './types.js';
import { firstLine, walk } from './engine.js';

function text(src: string, n: SyntaxNode | null): string { return n ? src.slice(n.startIndex, n.endIndex) : ''; }
function isPub(node: SyntaxNode): boolean { return node.namedChildren.some(c => c?.type === 'visibility_modifier'); }

/** Non-null named children — web-tree-sitter's `namedChildren` is typed `(Node | null)[]`. */
function namedChildren(n: SyntaxNode): SyntaxNode[] {
  return n.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

/**
 * Recursively flatten a `use` tree into RawImport entries, walking tree-sitter-rust's
 * use-tree nodes directly instead of text-splitting (so nested brace groups like
 * `use a::{b::{c, d}, e};` resolve correctly instead of leaking literal `{`/`}`).
 * `node` is a use-tree node (`identifier` | `scoped_identifier` | `scoped_use_list` |
 * `use_list` | `use_as_clause` | `use_wildcard` | `self`); `prefix` is the module
 * path accumulated from enclosing `scoped_use_list` groups (possibly '').
 */
function flattenUse(node: SyntaxNode, prefix: string, src: string, line: number, imports: RawImport[]): void {
  switch (node.type) {
    case 'self': {
      // `use foo::{self, bar}` -> bare module import for `foo` itself.
      imports.push({ module: prefix, names: [], line });
      break;
    }
    case 'identifier': {
      const name = text(src, node);
      if (prefix) imports.push({ module: prefix, names: [name], line });
      else imports.push({ module: name, names: [], line }); // top-level bare `use foo;`
      break;
    }
    case 'scoped_identifier': {
      const full = text(src, node);
      const parts = full.split('::');
      const name = parts.pop() ?? '';
      const modulePath = parts.join('::');
      const module = prefix ? (modulePath ? `${prefix}::${modulePath}` : prefix) : modulePath;
      imports.push({ module, names: [name], line });
      break;
    }
    case 'use_wildcard': {
      const inner = namedChildren(node)[0];
      const innerText = inner ? text(src, inner) : '';
      const module = prefix ? (innerText ? `${prefix}::${innerText}` : prefix) : innerText;
      imports.push({ module, names: ['*'], line });
      break;
    }
    case 'use_as_clause': {
      const pathNode = node.childForFieldName('path');
      const aliasNode = node.childForFieldName('alias');
      const alias = aliasNode ? text(src, aliasNode) : undefined;
      if (pathNode?.type === 'scoped_identifier') {
        const full = text(src, pathNode);
        const parts = full.split('::');
        const name = parts.pop() ?? '';
        const modulePath = parts.join('::');
        const module = prefix ? (modulePath ? `${prefix}::${modulePath}` : prefix) : modulePath;
        imports.push({ module, names: [name], alias, line });
      } else {
        const name = pathNode ? text(src, pathNode) : '';
        imports.push({ module: prefix || name, names: prefix ? [name] : [], alias, line });
      }
      break;
    }
    case 'scoped_use_list': {
      const pathNode = node.childForFieldName('path');
      const listNode = node.childForFieldName('list');
      const pathText = pathNode ? text(src, pathNode) : '';
      const newPrefix = prefix ? (pathText ? `${prefix}::${pathText}` : prefix) : pathText;
      if (listNode) for (const child of namedChildren(listNode)) flattenUse(child, newPrefix, src, line, imports);
      break;
    }
    case 'use_list': {
      for (const child of namedChildren(node)) flattenUse(child, prefix, src, line, imports);
      break;
    }
    default:
      break;
  }
}

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
    const symbols: RawSymbol[] = []; const imports: RawImport[] = []; const calls: RawCall[] = []; const inherits: RawInherit[] = []; const assigns: RawAssign[] = [];
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
          if (arg) flattenUse(arg, '', src, node.startPosition.row + 1, imports);
          break;
        }
        case 'let_declaration': {
          // `let x = Name::new(...)` / `Name::default()` / `Name::assoc_fn(...)` / `let x = Name { .. }`
          const patternNode = node.childForFieldName('pattern');
          const valueNode = node.childForFieldName('value');
          if (patternNode?.type === 'identifier' && valueNode) {
            let ctor: string | null = null;
            if (valueNode.type === 'call_expression') {
              const fn = valueNode.childForFieldName('function');
              if (fn?.type === 'scoped_identifier') {
                const pathNode = fn.childForFieldName('path');
                const seg = (pathNode ? text(src, pathNode) : '').split('::').pop() ?? '';
                if (/^[A-Z]/.test(seg)) ctor = seg;
              }
            } else if (valueNode.type === 'struct_expression') {
              const typeNode = valueNode.childForFieldName('name');
              const t = typeNode ? text(src, typeNode).replace(/<.*$/, '') : '';
              if (/^[A-Z]/.test(t)) ctor = t;
            }
            if (ctor) assigns.push({ name: text(src, patternNode), ctor, inside: enclosingFn(node, src), line: node.startPosition.row + 1 });
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
    return { symbols, imports, calls, inherits, assigns };
  },
};
