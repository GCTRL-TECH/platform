import { useScrollReveal } from '@/hooks/useScrollReveal'
import { SiteHeader } from '@/components/site/SiteHeader'
import { SiteFooter } from '@/components/site/SiteFooter'
import { Seo } from '@/components/Seo'
import { landingJsonLd } from '@/lib/seo-schema'
import { HeroSection } from './sections/HeroSection'
import { WorksWithSection } from './sections/WorksWithSection'
import { ArchitectureSection } from './sections/ArchitectureSection'
import { ProblemSection } from './sections/ProblemSection'
import { FusionStorySection } from './sections/FusionStorySection'
import { SpeedOfTrustSection } from './sections/SpeedOfTrustSection'
import { HowItWorksSection } from './sections/HowItWorksSection'
import { IntegrationsSection } from './sections/IntegrationsSection'
import { BenchmarksSection } from './sections/BenchmarksSection'
import { CtaSection } from './sections/CtaSection'

export function LandingPage() {
  useScrollReveal()

  return (
    <div className="min-h-screen bg-[#020617]">
      <Seo
        title="GCTRL - The Enterprise Memory Layer for AI"
        description="GCTRL (Ground Control) is the self-hosted knowledge graph and governed memory layer for AI agents. On-prem, local inference, no vendor lock-in, no token tax."
        path="/"
        jsonLd={landingJsonLd}
      />
      <SiteHeader />
      <main>
        <HeroSection />
        <WorksWithSection />
        <ProblemSection />
        <section id="how-it-works">
          <HowItWorksSection />
          <FusionStorySection />
        </section>
        <section id="architecture"><ArchitectureSection /></section>
        <section id="trust"><SpeedOfTrustSection /></section>
        <section id="integrations"><IntegrationsSection /></section>
        <section id="benchmarks"><BenchmarksSection /></section>
        <CtaSection />
      </main>
      <SiteFooter />
    </div>
  )
}
