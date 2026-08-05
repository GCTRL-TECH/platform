import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CalendarDays, ArrowLeft, ArrowRight } from 'lucide-react'
import { SiteHeader } from '@/components/site/SiteHeader'
import { SiteFooter } from '@/components/site/SiteFooter'
import { Seo, SITE_URL } from '@/components/Seo'
import { MarkdownView } from '@/pages/docs/MarkdownView'
import { BLOG_POSTS, getBlogPost, formatBlogDate, type BlogPost } from './registry'

function TagPills({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full border border-slate-700/60 bg-slate-800/60 px-2 py-0.5 text-[11px] text-slate-400"
        >
          {t}
        </span>
      ))}
    </span>
  )
}

function PostCard({ post }: { post: BlogPost }) {
  return (
    <Link
      to={`/blog/${post.slug}`}
      className="block rounded-2xl border border-slate-800 bg-slate-900/40 p-6 backdrop-blur-sm transition hover:border-indigo-400/40 hover:bg-indigo-500/[0.05]"
      data-umami-event="blog_card"
      data-umami-event-slug={post.slug}
    >
      <p className="flex items-center gap-2 text-xs text-slate-500">
        <CalendarDays size={13} />
        {formatBlogDate(post.date)}
      </p>
      <h2 className="mt-2 text-lg font-semibold text-white">{post.title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{post.description}</p>
      <div className="mt-4 flex items-center justify-between">
        <TagPills tags={post.tags} />
        <span className="flex items-center gap-1 text-xs font-medium text-indigo-400">
          Read <ArrowRight size={13} />
        </span>
      </div>
    </Link>
  )
}

export function BlogIndexPage() {
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])

  return (
    <div className="min-h-screen bg-[#020617]">
      <Seo
        title="Blog - GCTRL"
        description="Engineering notes on self-hosted knowledge graphs, GraphRAG, sovereign AI memory and compliance - from the team building GCTRL (Ground Control)."
        path="/blog"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: 'GCTRL Blog',
          url: `${SITE_URL}/blog`,
          description:
            'Engineering notes on self-hosted knowledge graphs, GraphRAG, sovereign AI memory and compliance.',
          publisher: { '@type': 'Organization', name: 'Cinque Monti Ltd.' },
        }}
      />
      <SiteHeader />

      <section className="relative overflow-hidden px-6 pt-32 pb-12">
        <div className="pointer-events-none absolute left-1/2 top-0 -z-0 h-96 w-[40rem] -translate-x-1/2 rounded-full bg-indigo-600/10 blur-[120px]" />
        <div className="relative mx-auto max-w-3xl text-center">
          <span className="glass-pill mb-5">Blog</span>
          <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl">
            Notes from{' '}
            <span className="bg-gradient-to-r from-indigo-400 via-violet-400 to-cyan-400 bg-clip-text text-transparent">
              Ground Control
            </span>
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-slate-400">
            Engineering notes on self-hosted knowledge graphs, GraphRAG, sovereign AI memory, and
            what it takes to run AI in regulated environments.
          </p>
        </div>
      </section>

      <section className="px-6 pb-24">
        <div className="mx-auto grid max-w-4xl gap-5">
          {BLOG_POSTS.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </section>

      <SiteFooter />
    </div>
  )
}

export function BlogPostPage() {
  const { slug } = useParams<{ slug: string }>()
  const post = slug ? getBlogPost(slug) : undefined

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [slug])

  if (!post) {
    return (
      <div className="min-h-screen bg-[#020617]">
        <Seo title="Post not found - GCTRL" description="This blog post does not exist." path={`/blog/${slug ?? ''}`} noindex />
        <SiteHeader />
        <section className="px-6 pt-32 pb-24 text-center">
          <h1 className="text-2xl font-bold text-white">Post not found</h1>
          <Link to="/blog" className="mt-4 inline-flex items-center gap-1 text-indigo-400 hover:text-indigo-300">
            <ArrowLeft size={14} /> Back to the blog
          </Link>
        </section>
        <SiteFooter />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#020617]">
      <Seo
        title={`${post.title} - GCTRL Blog`}
        description={post.description}
        path={`/blog/${post.slug}`}
        type="article"
        jsonLd={{
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: post.title,
          description: post.description,
          datePublished: post.date,
          author: { '@type': 'Organization', name: 'GCTRL', url: SITE_URL },
          publisher: { '@type': 'Organization', name: 'Cinque Monti Ltd.' },
          keywords: post.tags.join(', '),
          mainEntityOfPage: `${SITE_URL}/blog/${post.slug}`,
        }}
      />
      <SiteHeader />

      <article className="px-6 pt-32 pb-16">
        <div className="mx-auto max-w-3xl">
          <Link
            to="/blog"
            className="inline-flex items-center gap-1 text-sm text-slate-500 transition hover:text-indigo-400"
          >
            <ArrowLeft size={14} /> All posts
          </Link>

          <header className="mt-6">
            <p className="flex items-center gap-2 text-sm text-slate-500">
              <CalendarDays size={14} />
              {formatBlogDate(post.date)}
            </p>
            <h1 className="mt-3 text-3xl font-bold tracking-tight text-white sm:text-4xl">{post.title}</h1>
            <div className="mt-4">
              <TagPills tags={post.tags} />
            </div>
          </header>

          <div className="mt-10">
            <MarkdownView content={post.body} />
          </div>

          <div className="mt-14 rounded-2xl border border-indigo-500/20 bg-indigo-500/[0.06] px-8 py-6 text-center backdrop-blur-sm">
            <p className="text-base font-semibold text-white">Run your own memory layer.</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              GCTRL is the self-hosted knowledge graph and governed memory tier for AI - unlimited
              inference tokens on every plan, your hardware, your data.
            </p>
            <Link to="/register" className="btn-cta-primary mt-4 inline-flex" data-umami-event="blog_post_cta">
              Get started free
            </Link>
          </div>
        </div>
      </article>

      <SiteFooter />
    </div>
  )
}
