import { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router-dom'
import { slugifyHeading } from './registry'

function toText(node: ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toText).join('')
  // @ts-expect-error - React element children
  if (node?.props?.children) return toText(node.props.children)
  return ''
}

export function MarkdownView({ content }: { content: string }) {
  // Strip HTML comments so machine markers (e.g. the update-history post-routine's
  // anchor / baseline-sha / draft blocks) never render as visible text. Applies to
  // every docs page; comments are for source tooling, not readers.
  const clean = content.replace(/<!--[\s\S]*?-->/g, '')
  return (
    <div className="max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-6 text-3xl font-bold tracking-tight text-white sm:text-4xl">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2
              id={slugifyHeading(toText(children))}
              className="mt-12 scroll-mt-24 border-b border-slate-800 pb-2 text-2xl font-semibold text-slate-100"
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 id={slugifyHeading(toText(children))} className="mt-8 scroll-mt-24 text-lg font-semibold text-slate-100">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="my-4 leading-relaxed text-slate-300">{children}</p>,
          ul: ({ children }) => <ul className="my-4 ml-5 list-disc space-y-2 text-slate-300 marker:text-indigo-400">{children}</ul>,
          ol: ({ children }) => <ol className="my-4 ml-5 list-decimal space-y-2 text-slate-300 marker:text-slate-500">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children }) => {
            const h = href ?? '#'
            if (h.startsWith('http')) {
              return (
                <a href={h} target="_blank" rel="noreferrer" className="text-indigo-400 underline-offset-2 hover:text-indigo-300 hover:underline">
                  {children}
                </a>
              )
            }
            // Bare slug ("installation") → /docs/installation; "#anchor" stays; "/path" routes.
            const to = h.startsWith('#') ? h : h.startsWith('/') ? h : `/docs/${h.replace(/\.md$/, '')}`
            if (to.startsWith('#')) {
              return <a href={to} className="text-indigo-400 hover:text-indigo-300 hover:underline">{children}</a>
            }
            return <Link to={to} className="text-indigo-400 underline-offset-2 hover:text-indigo-300 hover:underline">{children}</Link>
          },
          strong: ({ children }) => <strong className="font-semibold text-slate-100">{children}</strong>,
          em: ({ children }) => <em className="italic text-slate-200">{children}</em>,
          hr: () => <hr className="my-10 border-slate-800" />,
          blockquote: ({ children }) => (
            <blockquote className="my-6 rounded-r-lg border-l-2 border-indigo-500/60 bg-indigo-500/5 px-4 py-2 text-slate-300">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const inline = !className
            if (inline) {
              return <code className="rounded bg-slate-800/80 px-1.5 py-0.5 font-mono text-[0.85em] text-cyan-300">{children}</code>
            }
            return <code className={`${className ?? ''} font-mono text-sm text-slate-200`}>{children}</code>
          },
          pre: ({ children }) => (
            <pre className="my-5 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/80 p-4 text-sm leading-relaxed">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-6 overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-slate-900/80">{children}</thead>,
          th: ({ children }) => <th className="border-b border-slate-800 px-4 py-2.5 text-left font-semibold text-slate-200">{children}</th>,
          td: ({ children }) => <td className="border-b border-slate-800/60 px-4 py-2.5 align-top text-slate-300">{children}</td>,
        }}
      >
        {clean}
      </ReactMarkdown>
    </div>
  )
}
