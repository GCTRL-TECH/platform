import { Helmet } from 'react-helmet-async'

/** Canonical origin for the marketing site. Every absolute URL (canonical,
 * og:url, og:image, twitter:image) is built from this constant. */
export const SITE_URL = 'https://gctrl.tech'

export interface SeoProps {
  /** Page <title>. Keep unique per route - this is what shows in search results and browser tabs. */
  title: string
  /** ~150-160 char meta description. Unique per route. */
  description: string
  /** Route path (e.g. "/pricing", "/docs/tech-kex") used to build canonical + og:url. */
  path: string
  /** Absolute or root-relative image path. Defaults to the shared branded OG raster. */
  image?: string
  /** Open Graph type. Defaults to "website"; docs/article pages should pass "article". */
  type?: 'website' | 'article'
  /** Optional JSON-LD structured data - pass one object or an array of objects (e.g. @graph members). */
  jsonLd?: Record<string, unknown> | Record<string, unknown>[]
  /** Set to true to keep a page out of search indexes (e.g. auth-gated app screens). Defaults to indexable. */
  noindex?: boolean
}

export function Seo({ title, description, path, image, type = 'website', jsonLd, noindex = false }: SeoProps) {
  const url = `${SITE_URL}${path}`
  const imageUrl = image ? (image.startsWith('http') ? image : `${SITE_URL}${image}`) : `${SITE_URL}/og.png`
  const robots = noindex ? 'noindex, nofollow' : 'index, follow'

  const jsonLdBlocks = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : []

  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />
      <meta name="robots" content={robots} />

      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={imageUrl} />
      <meta property="og:type" content={type} />
      <meta property="og:site_name" content="GCTRL" />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={imageUrl} />

      {jsonLdBlocks.map((block, i) => (
        <script key={i} type="application/ld+json">
          {JSON.stringify(block)}
        </script>
      ))}
    </Helmet>
  )
}
