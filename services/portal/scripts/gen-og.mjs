#!/usr/bin/env node
// Generates a branded 1200x630 raster Open Graph image (public/og.png).
//
// Why: social scrapers (Slack, Twitter/X, LinkedIn, Discord, and most LLM
// crawlers that render link previews) cannot rasterize SVG og:image tags —
// they need a PNG/JPEG. This composes the existing brand hexagon icon +
// wordmark vector art from public/gctrl/*.svg into one on-brand raster via
// @resvg/resvg-js (no native build step, prebuilt binaries).
//
// Run manually with `npm run gen:og`, or automatically via `prebuild`.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const W = 1200
const H = 630

// The hexagon icon's inner markup (viewBox -55 -55 110 110) — reused as-is,
// just re-positioned/scaled inside the composite canvas below.
const iconSvg = readFileSync(path.join(root, 'public/gctrl/icon-color.svg'), 'utf8')
const iconInner = iconSvg.match(/<g transform="translate\(0, 0\)">[\s\S]*?<\/g>\s*<\/g>/)?.[0]
  ?? iconSvg.replace(/<\?xml[^>]*\?>/, '').replace(/<\/?svg[^>]*>/g, '')

const composite = `
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="42%" r="65%">
      <stop offset="0%" stop-color="#1F3B8C" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="#150E33" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#04040f" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="titleGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="55%" stop-color="#a78bfa"/>
      <stop offset="100%" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="#04040f"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>

  <!-- Hex icon, upper-left of the text block -->
  <g transform="translate(120, 175) scale(1.35)">
    ${iconInner}
  </g>

  <!-- Wordmark -->
  <text x="230" y="240" font-family="Arial, Helvetica, sans-serif" font-size="66" font-weight="700" fill="#ffffff" letter-spacing="1">GCTRL</text>

  <!-- Headline -->
  <text x="120" y="345" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="700" fill="url(#titleGrad)">The Enterprise Memory Layer</text>
  <text x="120" y="410" font-family="Arial, Helvetica, sans-serif" font-size="54" font-weight="700" fill="url(#titleGrad)">for AI</text>

  <!-- Subline -->
  <text x="122" y="465" font-family="Arial, Helvetica, sans-serif" font-size="26" fill="#94a3b8">Self-hosted knowledge graphs. Governed memory. No token tax.</text>

  <!-- Bottom tag row -->
  <text x="122" y="560" font-family="Arial, Helvetica, sans-serif" font-size="20" fill="#64748b" letter-spacing="2">GCTRL.TECH  ·  ON-PREM  ·  GDPR-READY  ·  OPEN SOURCE</text>
</svg>
`.trim()

const resvg = new Resvg(composite, {
  font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
  background: '#04040f',
  fitTo: { mode: 'width', value: W },
})
const png = resvg.render().asPng()
const outPath = path.join(root, 'public/og.png')
writeFileSync(outPath, png)
console.log(`[gen-og] wrote ${outPath} (${png.length} bytes)`)
