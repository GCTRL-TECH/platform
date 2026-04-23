/**
 * Project Management Connectors
 * Jira, Confluence, Notion, Linear
 * Fetch issues, pages, tasks and convert to text for KEX.
 */

// ─── Jira ────────────────────────────────────────────────────────────────────

export interface JiraConfig {
  baseUrl: string;       // e.g. https://mycompany.atlassian.net
  email: string;
  apiToken: string;
}

function jiraHeaders(config: JiraConfig): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

export async function fetchJiraIssues(config: JiraConfig, jql = 'ORDER BY updated DESC', maxResults = 50): Promise<string> {
  const resp = await fetch(
    `${config.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,description,status,assignee,priority,labels,created,updated,comment`,
    { headers: jiraHeaders(config) },
  );
  if (!resp.ok) throw new Error(`Jira API error: ${resp.status}`);

  const data = await resp.json() as { issues: Array<{ key: string; fields: Record<string, unknown> }> };

  return data.issues.map((issue) => {
    const f = issue.fields;
    const parts = [`${issue.key}: ${f.summary || 'No title'}`];

    const status = f.status as { name?: string } | null;
    if (status?.name) parts.push(`Status: ${status.name}`);

    const assignee = f.assignee as { displayName?: string } | null;
    if (assignee?.displayName) parts.push(`Assignee: ${assignee.displayName}`);

    const priority = f.priority as { name?: string } | null;
    if (priority?.name) parts.push(`Priority: ${priority.name}`);

    const labels = f.labels as string[] | null;
    if (labels?.length) parts.push(`Labels: ${labels.join(', ')}`);

    // Extract description text (ADF format → plain text)
    const desc = f.description as { content?: Array<{ content?: Array<{ text?: string }> }> } | null;
    if (desc?.content) {
      const text = desc.content
        .flatMap((block) => block.content?.map((c) => c.text) || [])
        .filter(Boolean)
        .join(' ');
      if (text) parts.push(`Description: ${text}`);
    }

    return parts.join('\n');
  }).join('\n\n---\n\n');
}

export async function listJiraProjects(config: JiraConfig): Promise<Array<{ key: string; name: string }>> {
  const resp = await fetch(`${config.baseUrl}/rest/api/3/project`, { headers: jiraHeaders(config) });
  if (!resp.ok) throw new Error(`Jira projects error: ${resp.status}`);
  const data = await resp.json() as Array<{ key: string; name: string }>;
  return data.map((p) => ({ key: p.key, name: p.name }));
}

// ─── Confluence ──────────────────────────────────────────────────────────────

export interface ConfluenceConfig {
  baseUrl: string;       // e.g. https://mycompany.atlassian.net/wiki
  email: string;
  apiToken: string;
}

export async function fetchConfluencePages(config: ConfluenceConfig, spaceKey?: string, limit = 25): Promise<string> {
  const cql = spaceKey ? `space="${spaceKey}" ORDER BY lastmodified DESC` : 'ORDER BY lastmodified DESC';
  const resp = await fetch(
    `${config.baseUrl}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=body.storage`,
    { headers: jiraHeaders({ baseUrl: config.baseUrl, email: config.email, apiToken: config.apiToken }) },
  );
  if (!resp.ok) throw new Error(`Confluence API error: ${resp.status}`);

  const data = await resp.json() as { results: Array<{ title: string; body?: { storage?: { value: string } }; _links?: { webui?: string } }> };

  return data.results.map((page) => {
    let body = page.body?.storage?.value || '';
    // Strip HTML tags for plain text
    body = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const parts = [`Page: ${page.title}`];
    if (body) parts.push(body.slice(0, 5000));
    return parts.join('\n\n');
  }).join('\n\n===\n\n');
}

// ─── Notion ──────────────────────────────────────────────────────────────────

export interface NotionConfig {
  apiToken: string;      // Internal integration token
}

function notionHeaders(config: NotionConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
}

export async function fetchNotionPages(config: NotionConfig, databaseId?: string, limit = 50): Promise<string> {
  let pages: Array<{ id: string; properties: Record<string, unknown>; url: string }>;

  if (databaseId) {
    const resp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: notionHeaders(config),
      body: JSON.stringify({ page_size: limit }),
    });
    if (!resp.ok) throw new Error(`Notion query error: ${resp.status}`);
    const data = await resp.json() as { results: typeof pages };
    pages = data.results;
  } else {
    const resp = await fetch(`https://api.notion.com/v1/search`, {
      method: 'POST',
      headers: notionHeaders(config),
      body: JSON.stringify({ page_size: limit, filter: { value: 'page', property: 'object' } }),
    });
    if (!resp.ok) throw new Error(`Notion search error: ${resp.status}`);
    const data = await resp.json() as { results: typeof pages };
    pages = data.results;
  }

  const results: string[] = [];

  for (const page of pages.slice(0, limit)) {
    // Get page content (blocks)
    try {
      const blocksResp = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`, {
        headers: notionHeaders(config),
      });
      if (!blocksResp.ok) continue;

      const blocksData = await blocksResp.json() as { results: Array<{ type: string; [key: string]: unknown }> };

      const title = extractNotionTitle(page.properties);
      const content = blocksData.results
        .map((block) => extractNotionBlockText(block))
        .filter(Boolean)
        .join('\n');

      if (title || content) {
        results.push(`Page: ${title || 'Untitled'}\n${content}`);
      }
    } catch {
      // Skip pages we can't read
    }
  }

  return results.join('\n\n===\n\n');
}

function extractNotionTitle(properties: Record<string, unknown>): string {
  for (const val of Object.values(properties)) {
    const prop = val as { type?: string; title?: Array<{ plain_text: string }> };
    if (prop.type === 'title' && prop.title?.length) {
      return prop.title.map((t) => t.plain_text).join('');
    }
  }
  return '';
}

function extractNotionBlockText(block: Record<string, unknown>): string {
  const type = block.type as string;
  const content = block[type] as { rich_text?: Array<{ plain_text: string }>; children?: unknown[] } | undefined;
  if (!content?.rich_text) return '';
  return content.rich_text.map((t) => t.plain_text).join('');
}

export async function listNotionDatabases(config: NotionConfig): Promise<Array<{ id: string; title: string }>> {
  const resp = await fetch('https://api.notion.com/v1/search', {
    method: 'POST',
    headers: notionHeaders(config),
    body: JSON.stringify({ filter: { value: 'database', property: 'object' }, page_size: 50 }),
  });
  if (!resp.ok) throw new Error(`Notion error: ${resp.status}`);
  const data = await resp.json() as { results: Array<{ id: string; title: Array<{ plain_text: string }> }> };
  return data.results.map((d) => ({ id: d.id, title: d.title?.map((t) => t.plain_text).join('') || 'Untitled' }));
}

// ─── Linear ──────────────────────────────────────────────────────────────────

export interface LinearConfig {
  apiKey: string;
}

export async function fetchLinearIssues(config: LinearConfig, teamKey?: string, limit = 50): Promise<string> {
  const filter = teamKey ? `team: { key: { eq: "${teamKey}" } }` : '';
  const query = `{
    issues(first: ${limit}, ${filter ? `filter: { ${filter} },` : ''} orderBy: updatedAt) {
      nodes {
        identifier
        title
        description
        state { name }
        assignee { name }
        priority
        labels { nodes { name } }
        createdAt
        updatedAt
      }
    }
  }`;

  const resp = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: config.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) throw new Error(`Linear API error: ${resp.status}`);

  const data = await resp.json() as { data: { issues: { nodes: Array<{
    identifier: string; title: string; description?: string;
    state?: { name: string }; assignee?: { name: string };
    priority: number; labels?: { nodes: Array<{ name: string }> };
  }> } } };

  return data.data.issues.nodes.map((issue) => {
    const parts = [`${issue.identifier}: ${issue.title}`];
    if (issue.state?.name) parts.push(`Status: ${issue.state.name}`);
    if (issue.assignee?.name) parts.push(`Assignee: ${issue.assignee.name}`);
    if (issue.labels?.nodes.length) parts.push(`Labels: ${issue.labels.nodes.map((l) => l.name).join(', ')}`);
    if (issue.description) parts.push(`Description: ${issue.description.slice(0, 2000)}`);
    return parts.join('\n');
  }).join('\n\n---\n\n');
}

export async function listLinearTeams(config: LinearConfig): Promise<Array<{ id: string; key: string; name: string }>> {
  const resp = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: config.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ teams { nodes { id key name } } }' }),
  });
  if (!resp.ok) throw new Error(`Linear error: ${resp.status}`);
  const data = await resp.json() as { data: { teams: { nodes: Array<{ id: string; key: string; name: string }> } } };
  return data.data.teams.nodes;
}
