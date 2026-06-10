/**
 * MarkdownView — thin react-markdown wrapper with a Tailwind slate theme.
 *
 * Default export so callers can `lazy(() => import('./MarkdownView'))`, which
 * ensures the (relatively large) react-markdown bundle stays in its own chunk.
 */

import ReactMarkdown from 'react-markdown'

export default function MarkdownView({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={{
        p: ({ children }) => (
          <p className="text-sm text-slate-300 leading-relaxed mb-2">{children}</p>
        ),
        code: ({ children }) => (
          <code className="bg-slate-800 text-amber-300 px-1 py-0.5 rounded text-xs">
            {children}
          </code>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-blue-400 hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
        li: ({ children }) => (
          <li className="text-sm text-slate-300 ml-4 list-disc">{children}</li>
        ),
        h1: ({ children }) => (
          <h1 className="text-base font-semibold text-slate-100 mt-3 mb-1">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-sm font-semibold text-slate-200 mt-2 mb-1">{children}</h2>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold text-slate-100">{children}</strong>
        ),
        em: ({ children }) => <em className="italic text-slate-200">{children}</em>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-slate-700 pl-3 italic text-slate-400">
            {children}
          </blockquote>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
