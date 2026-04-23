/**
 * CRM Connectors
 * Salesforce and HubSpot — fetch contacts, deals, companies, notes
 * and convert to text for KEX extraction.
 */

// ─── Salesforce ──────────────────────────────────────────────────────────────

export interface SalesforceConfig {
  instanceUrl: string;   // e.g. https://mycompany.salesforce.com
  accessToken: string;
}

export interface SalesforceRecord {
  Id: string;
  [key: string]: unknown;
}

async function sfQuery(config: SalesforceConfig, soql: string): Promise<SalesforceRecord[]> {
  const resp = await fetch(
    `${config.instanceUrl}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${config.accessToken}`, Accept: 'application/json' } },
  );
  if (!resp.ok) throw new Error(`Salesforce API error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json() as { records: SalesforceRecord[] };
  return data.records;
}

export async function listSalesforceObjects(config: SalesforceConfig): Promise<string[]> {
  const resp = await fetch(
    `${config.instanceUrl}/services/data/v59.0/sobjects`,
    { headers: { Authorization: `Bearer ${config.accessToken}` } },
  );
  if (!resp.ok) throw new Error(`Salesforce error: ${resp.status}`);
  const data = await resp.json() as { sobjects: Array<{ name: string; queryable: boolean }> };
  return data.sobjects.filter((o) => o.queryable).map((o) => o.name);
}

export async function fetchSalesforceContacts(config: SalesforceConfig, limit = 200): Promise<string> {
  const records = await sfQuery(config, `SELECT Id, FirstName, LastName, Email, Phone, Title, Company, Description FROM Contact LIMIT ${limit}`);
  return records.map((r) => {
    const parts = [`Contact: ${r.FirstName || ''} ${r.LastName || ''}`.trim()];
    if (r.Email) parts.push(`Email: ${r.Email}`);
    if (r.Phone) parts.push(`Phone: ${r.Phone}`);
    if (r.Title) parts.push(`Title: ${r.Title}`);
    if (r.Company) parts.push(`Company: ${r.Company}`);
    if (r.Description) parts.push(`Notes: ${r.Description}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');
}

export async function fetchSalesforceDeals(config: SalesforceConfig, limit = 200): Promise<string> {
  const records = await sfQuery(config, `SELECT Id, Name, Amount, StageName, CloseDate, Description, Account.Name FROM Opportunity LIMIT ${limit}`);
  return records.map((r) => {
    const parts = [`Deal: ${r.Name}`];
    if (r.Amount) parts.push(`Amount: ${r.Amount}`);
    if (r.StageName) parts.push(`Stage: ${r.StageName}`);
    if (r.CloseDate) parts.push(`Close Date: ${r.CloseDate}`);
    const account = r.Account as { Name?: string } | null;
    if (account?.Name) parts.push(`Account: ${account.Name}`);
    if (r.Description) parts.push(`Description: ${r.Description}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');
}

export async function fetchSalesforceAccounts(config: SalesforceConfig, limit = 200): Promise<string> {
  const records = await sfQuery(config, `SELECT Id, Name, Industry, Website, Phone, Description, BillingCity, BillingCountry FROM Account LIMIT ${limit}`);
  return records.map((r) => {
    const parts = [`Company: ${r.Name}`];
    if (r.Industry) parts.push(`Industry: ${r.Industry}`);
    if (r.Website) parts.push(`Website: ${r.Website}`);
    if (r.Phone) parts.push(`Phone: ${r.Phone}`);
    if (r.BillingCity || r.BillingCountry) parts.push(`Location: ${r.BillingCity || ''}, ${r.BillingCountry || ''}`);
    if (r.Description) parts.push(`Description: ${r.Description}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');
}

// ─── HubSpot ─────────────────────────────────────────────────────────────────

export interface HubSpotConfig {
  accessToken: string;   // Private app token or OAuth token
}

async function hsGet(config: HubSpotConfig, path: string): Promise<unknown> {
  const resp = await fetch(`https://api.hubapi.com${path}`, {
    headers: { Authorization: `Bearer ${config.accessToken}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`HubSpot API error: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

export async function fetchHubSpotContacts(config: HubSpotConfig, limit = 100): Promise<string> {
  const data = await hsGet(config, `/crm/v3/objects/contacts?limit=${limit}&properties=firstname,lastname,email,phone,company,jobtitle,notes_last_updated`) as {
    results: Array<{ properties: Record<string, string | null> }>;
  };

  return data.results.map((c) => {
    const p = c.properties;
    const parts = [`Contact: ${p.firstname || ''} ${p.lastname || ''}`.trim()];
    if (p.email) parts.push(`Email: ${p.email}`);
    if (p.phone) parts.push(`Phone: ${p.phone}`);
    if (p.company) parts.push(`Company: ${p.company}`);
    if (p.jobtitle) parts.push(`Title: ${p.jobtitle}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');
}

export async function fetchHubSpotDeals(config: HubSpotConfig, limit = 100): Promise<string> {
  const data = await hsGet(config, `/crm/v3/objects/deals?limit=${limit}&properties=dealname,amount,dealstage,closedate,pipeline,description`) as {
    results: Array<{ properties: Record<string, string | null> }>;
  };

  return data.results.map((d) => {
    const p = d.properties;
    const parts = [`Deal: ${p.dealname || 'Untitled'}`];
    if (p.amount) parts.push(`Amount: ${p.amount}`);
    if (p.dealstage) parts.push(`Stage: ${p.dealstage}`);
    if (p.closedate) parts.push(`Close: ${p.closedate}`);
    if (p.pipeline) parts.push(`Pipeline: ${p.pipeline}`);
    if (p.description) parts.push(`Description: ${p.description}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');
}

export async function fetchHubSpotCompanies(config: HubSpotConfig, limit = 100): Promise<string> {
  const data = await hsGet(config, `/crm/v3/objects/companies?limit=${limit}&properties=name,domain,industry,phone,city,country,description`) as {
    results: Array<{ properties: Record<string, string | null> }>;
  };

  return data.results.map((c) => {
    const p = c.properties;
    const parts = [`Company: ${p.name || 'Unknown'}`];
    if (p.domain) parts.push(`Website: ${p.domain}`);
    if (p.industry) parts.push(`Industry: ${p.industry}`);
    if (p.phone) parts.push(`Phone: ${p.phone}`);
    if (p.city || p.country) parts.push(`Location: ${p.city || ''}, ${p.country || ''}`);
    if (p.description) parts.push(`Description: ${p.description}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');
}
