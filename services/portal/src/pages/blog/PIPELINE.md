# Blog Publishing Pipeline - Operating Manual

This file is the contract for the automated SEO/content routine that publishes to
gctrl.tech/blog. A human editing the blog follows the same rules.

## How publishing works (the whole mechanism)

1. A post is ONE markdown file in `src/pages/blog/content/<slug>.md` with frontmatter:
   ```
   ---
   title: The Post Title
   date: 2026-08-05
   description: 120-157 char meta description with the target keyword.
   tags: [tag-one, tag-two]
   ---
   Body markdown. NO H1 in the body (the page renders the title). Start with a
   paragraph, then ## sections.
   ```
2. That is the entire per-post contract. Slugs, ordering, prerendering
   (`src/App.tsx` BLOG_SLUGS), and sitemap entries (`scripts/gen-sitemap.mjs`)
   all derive from the content directory automatically.
3. Push to main -> CI path filter `services/portal/**` triggers the portal image
   build (which regenerates the sitemap) and deploys gctrl.tech. Nothing else to do.

## Per-run procedure (the routine executes this)

1. **Fetch stats:** GET the Umami stats bridge (n8n webhook, URL + key in the
   routine's configuration). It returns pageviews/visitors by URL, referrers,
   and 7d/28d trends for gctrl.tech including /blog/* paths.
2. **Optimize before writing (self-optimization pass):**
   - Post with pageviews but near-zero avg time / instant bounce -> rewrite the
     intro paragraph (content mismatch with the promise of the title).
   - Post indexed 21+ days with ~zero impressions-driven traffic -> rewrite
     `title:` and `description:` (keep the slug STABLE - never change slugs).
   - Rising post -> add 2-3 internal links from it to conversion pages
     (/pricing, /register) and to newer related posts, if not already present.
   - Log every optimization decision in `OPTLOG.md` (append-only, date + action
     + reason + the metric that triggered it). Review what past changes did
     before making new ones - do not thrash: one title rewrite per post per month max.
3. **Write the next post:** take the top `queued` topic from `BACKLOG.md`,
   research it (web search for current facts - VERIFY dates/regulations/prices),
   write 700-1200 words following the quality bar below, save under a new slug,
   mark the backlog entry `published: <slug>`.
4. **Refill the backlog:** if fewer than 15 `queued` topics remain, research and
   append new ones (see "Research notes" in BACKLOG.md). Prefer topics real
   users demonstrably search for; note keywords + angle + internal links.
5. **Update the docs updates page? NO.** Blog-content pushes are exempt from the
   /docs/updates release-notes rule (that page tracks PRODUCT releases). Do not
   add entries there for posts.
6. **Commit and push** with message `blog: <slug>` (plus `blog-ops: ...` for
   optimization-only changes).

## Quality bar (non-negotiable)

- **Language:** English. **NO em-dashes or en-dashes anywhere** - plain "-" only.
- **Honesty:** never claim certifications (posture, not certification), never
  name competitors (describe their pricing/structure generically), never state
  benchmark numbers not on /docs/benchmarks, mark legal topics as not-legal-advice.
- **Product facts must be current:** pricing claims must match /pricing
  (unlimited tokens on every plan; Business EUR 29 per license with 10 colleague
  tokens; Enterprise EUR 25,000/year, 100 seats). When in doubt, link instead of restate.
- **Structure:** title <= 65 chars with the target keyword; description 120-157
  chars; 2-5 tags; ## sections; at least 3 internal links (/docs/*, /pricing,
  /blog/*) and at most 1 external link; end with a soft CTA or cross-link.
- **Voice:** engineer-to-engineer, concrete, willing to state trade-offs
  honestly (the "What self-hosting actually takes (honestly)" pattern). No
  content-farm filler, no keyword stuffing.
- **Cadence:** 2 posts/week (Tue + Thu). If stats show declining returns from
  frequency, reduce cadence before reducing quality - and say so in OPTLOG.md.

## Boundaries (hard)

- Touch ONLY: `src/pages/blog/content/*.md`, `BACKLOG.md`, `OPTLOG.md` in this
  directory. Never edit other site pages, pricing, docs, or components.
- Never delete a published post (fix or de-emphasize instead).
- Never change a published slug (breaks indexed URLs).
- If the build would break (frontmatter typo etc.), fix forward before pushing:
  `npm run build` in services/portal must pass.
