import { useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SiteHeader } from '@/components/site/SiteHeader'
import { SiteFooter } from '@/components/site/SiteFooter'
import { Seo } from '@/components/Seo'

// Single legal entity for the whole product / site.
const COMPANY = 'Cinque Monti Ltd.'
const EMAIL = 'fabio@5monti.com'
const UPDATED = '17 June 2026'

/** A placeholder for a statutory detail the company will fill in. Rendered as a
 *  neutral, unobtrusive stub rather than an alarming highlight. */
function Fill({ children }: { children: ReactNode }) {
  return <span className="italic text-slate-500">[{children}]</span>
}

function LegalLayout({
  title,
  children,
  path,
  description,
}: {
  title: string
  children: ReactNode
  path: string
  description: string
}) {
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [])
  return (
    <div className="min-h-screen bg-[#020617]">
      <Seo title={`${title} - GCTRL`} description={description} path={path} />
      <SiteHeader />
      <section className="px-6 pt-32 pb-24">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-3xl font-bold text-white sm:text-4xl">{title}</h1>
          <p className="mt-2 text-sm text-slate-500">Last updated: {UPDATED}</p>
          <div className="mt-10 space-y-8">{children}</div>
        </div>
      </section>
      <SiteFooter />
    </div>
  )
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold text-white">{heading}</h2>
      <div className="mt-3 space-y-3 leading-relaxed text-slate-400">{children}</div>
    </section>
  )
}

export function ImprintPage() {
  return (
    <LegalLayout
      title="Legal Notice (Imprint)"
      path="/imprint"
      description="Legal notice and statutory registration details for Cinque Monti Ltd., the operator of GCTRL (Ground Control)."
    >
      <p className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-500">
        Statutory registration details are being finalized and will be completed here shortly. For any
        enquiries in the meantime, please contact us at the email below.
      </p>

      <Section heading="Company">
        <p>
          <span className="font-medium text-slate-200">{COMPANY}</span>
          <br />
          <Fill>Registered office address</Fill>
        </p>
        <p>
          Represented by: <Fill>Managing Director name</Fill>
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Email:{' '}
          <a href={`mailto:${EMAIL}`} className="text-indigo-400 hover:text-indigo-300">
            {EMAIL}
          </a>
        </p>
      </Section>

      <Section heading="Register & VAT">
        <p>
          Company registration number: <Fill>company number</Fill>
          <br />
          Registered at: <Fill>register / jurisdiction, e.g. Companies House</Fill>
          <br />
          VAT identification number: <Fill>VAT ID, if applicable</Fill>
        </p>
      </Section>

      <Section heading="Responsible for content">
        <p>
          <Fill>Responsible person’s name</Fill>, at the address above.
        </p>
      </Section>

      <Section heading="Liability for content">
        <p>
          The contents of these pages were created with the greatest possible care. However, we cannot
          guarantee the contents’ accuracy, completeness, or topicality. As a service provider, {COMPANY} is
          responsible for its own content on these pages under general law. We are under no obligation to
          monitor transmitted or stored third-party information, or to investigate circumstances that indicate
          illegal activity.
        </p>
      </Section>

      <Section heading="Liability for links">
        <p>
          Our site may contain links to external websites over whose content we have no control. We therefore
          accept no liability for this third-party content. The respective provider or operator of the linked
          pages is always responsible for their content. We will remove such links immediately upon becoming
          aware of any legal violation.
        </p>
      </Section>

      <Section heading="Copyright">
        <p>
          The content and works on these pages are protected by copyright. Any reproduction, processing,
          distribution, or use beyond the limits of copyright requires the prior written consent of {COMPANY}.
        </p>
      </Section>

      <p className="text-sm text-slate-500">
        See also our{' '}
        <Link to="/privacy" className="text-indigo-400 hover:text-indigo-300">
          Privacy Policy
        </Link>
        .
      </p>
    </LegalLayout>
  )
}

export function PrivacyPolicyPage() {
  return (
    <LegalLayout
      title="Privacy Policy"
      path="/privacy"
      description="How GCTRL and Cinque Monti Ltd. handle personal data: cookieless analytics, GDPR rights, data retention, and our on-prem, privacy-by-design approach."
    >
      <Section heading="1. Who is responsible (controller)">
        <p>
          The controller for the processing of personal data on this website is:
        </p>
        <p>
          <span className="font-medium text-slate-200">{COMPANY}</span>
          <br />
          <Fill>Registered office address</Fill>
          <br />
          Email:{' '}
          <a href={`mailto:${EMAIL}`} className="text-indigo-400 hover:text-indigo-300">
            {EMAIL}
          </a>
        </p>
      </Section>

      <Section heading="2. Our approach to your data">
        <p>
          Privacy is built into how this product works, not added on afterwards. We practice data minimization,
          we do not sell your data, and we do not use third-party advertising or cross-site tracking. Wherever
          possible, processing happens locally and stays within our own infrastructure.
        </p>
      </Section>

      <Section heading="3. Visiting this website (server logs)">
        <p>
          When you visit our website, our hosting provider automatically records technical access data (such as
          the requested page, date and time, referrer, and a shortened/anonymized IP address) in server log
          files. This is necessary to deliver the site, ensure stability, and protect against attacks.
        </p>
        <p>
          Legal basis: our legitimate interest in a secure and functional website (Art. 6(1)(f) GDPR).
        </p>
      </Section>

      <Section heading="4. Cookies">
        <p>
          Our public website does <span className="font-medium text-slate-200">not</span> use tracking or
          advertising cookies, and therefore does not display a cookie-consent banner. Where you log into the
          product, a strictly necessary session mechanism may be used to keep you signed in; this is not used
          for tracking.
        </p>
      </Section>

      <Section heading="5. Analytics (cookieless, self-hosted)">
        <p>
          We measure aggregate website usage with <span className="font-medium text-slate-200">Umami</span>, a
          privacy-friendly analytics tool that we host ourselves on our own server. It is{' '}
          <span className="font-medium text-slate-200">cookieless</span> and sets no identifiers on your device.
          It does not store personal data: IP addresses are anonymized via a daily-rotating hash and are not
          retained, and no profiles are built across websites.
        </p>
        <p>
          We use this only to understand aggregate trends (e.g. page views, referrers, country, device type).
          Retention is limited (up to 12 months). Because no personal data is stored and nothing is read from
          or written to your device, this processing does not require consent and is based on our legitimate
          interest in understanding and improving our site (Art. 6(1)(f) GDPR).
        </p>
      </Section>

      <Section heading="6. Registration and use of the product">
        <p>
          If you create an account or activate a license, we process the data you provide (such as your email
          address and account credentials) to operate the service, manage your license, and communicate with
          you about it. Legal basis: performance of a contract (Art. 6(1)(b) GDPR).
        </p>
        <p>
          The GCTRL product is designed to run on your own infrastructure with local inference. Knowledge you
          process in the product, and conversational sessions in the chat features, are handled under our
          GDPR-by-design model and are not stored by us for our own purposes.
        </p>
      </Section>

      <Section heading="7. Contacting us">
        <p>
          If you contact us by email, we process your message and contact details to handle your request. Legal
          basis: our legitimate interest in responding to enquiries, or pre-contractual/contractual measures
          where applicable (Art. 6(1)(f) / (b) GDPR).
        </p>
      </Section>

      <Section heading="8. Hosting">
        <p>
          This website and its analytics are hosted on our own virtual server provided by Hostinger, located in{' '}
          <Fill>data-centre region, e.g. EU</Fill>. Our hosting provider processes data strictly on our behalf
          as a processor under a data-processing agreement.
        </p>
      </Section>

      <Section heading="9. Data retention">
        <p>
          We keep personal data only as long as necessary for the purposes described above or as required by
          law. Server logs and anonymized analytics are kept for a limited period and then deleted or
          aggregated. Account data is kept for the duration of your account relationship.
        </p>
      </Section>

      <Section heading="10. Your rights">
        <p>Under the GDPR you have the right to:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>access the personal data we hold about you (Art. 15);</li>
          <li>have inaccurate data corrected (Art. 16);</li>
          <li>have your data erased (Art. 17);</li>
          <li>restrict processing (Art. 18);</li>
          <li>data portability (Art. 20);</li>
          <li>object to processing based on legitimate interests (Art. 21);</li>
          <li>withdraw consent at any time, where processing is based on consent.</li>
        </ul>
        <p>
          To exercise any of these rights, contact us at{' '}
          <a href={`mailto:${EMAIL}`} className="text-indigo-400 hover:text-indigo-300">
            {EMAIL}
          </a>
          . You also have the right to lodge a complaint with the competent data-protection supervisory
          authority in your country.
        </p>
      </Section>

      <Section heading="11. Data security">
        <p>
          We use appropriate technical and organizational measures to protect your data against loss, misuse,
          and unauthorized access, including encrypted transport (HTTPS) and access controls.
        </p>
      </Section>

      <Section heading="12. Changes to this policy">
        <p>
          We may update this policy to reflect changes to our service or legal requirements. The current version
          is always available on this page, with the “last updated” date shown above.
        </p>
      </Section>

      <p className="text-sm text-slate-500">
        See also our{' '}
        <Link to="/imprint" className="text-indigo-400 hover:text-indigo-300">
          Legal Notice
        </Link>
        .
      </p>
    </LegalLayout>
  )
}
