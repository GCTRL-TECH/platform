import { useScrollReveal } from '@/hooks/useScrollReveal'
import { SiteHeader } from '@/components/site/SiteHeader'
import { SiteFooter } from '@/components/site/SiteFooter'
import { HeroSection } from './sections/HeroSection'
import { ArchitectureSection } from './sections/ArchitectureSection'
import { ProblemSection } from './sections/ProblemSection'
import { SpeedOfTrustSection } from './sections/SpeedOfTrustSection'
import { HowItWorksSection } from './sections/HowItWorksSection'
import { ExplainabilitySection } from './sections/ExplainabilitySection'
import { IntegrationsSection } from './sections/IntegrationsSection'
import { BenchmarksSection } from './sections/BenchmarksSection'
import { CtaSection } from './sections/CtaSection'

export function LandingPage() {
  useScrollReveal()

  return (
    <div className="min-h-screen bg-[#020617]">
      <SiteHeader />
      <main>
        <HeroSection />
        <section id="architecture"><ArchitectureSection /></section>
        <ProblemSection />
        <section id="trust"><SpeedOfTrustSection /></section>
        <section id="how-it-works"><HowItWorksSection /></section>
        <ExplainabilitySection />
        <section id="integrations"><IntegrationsSection /></section>
        <section id="benchmarks"><BenchmarksSection /></section>
        <CtaSection />
      </main>
      <SiteFooter />
    </div>
  )
}
