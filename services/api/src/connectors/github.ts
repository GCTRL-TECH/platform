/**
 * GitHub Connector
 * Handles: Repositories, Issues, Pull Requests, Code Files, README
 * Uses GitHub REST API v3 with personal access token or OAuth.
 */

import { getValidToken } from './token-manager.js';

const GITHUB_API = 'https://api.github.com';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  topics: string[];
  updated_at: string;
  stargazers_count: number;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string };
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  comments: number;
  html_url: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string };
  head: { ref: string };
  base: { ref: string };
  created_at: string;
  merged_at: string | null;
  html_url: string;
}

// ─── Helper ──────────────────────────────────────────────────────────────────

async function githubApi(
  connectorId: string,
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const token = await getValidToken(connectorId);

  const url = new URL(`${GITHUB_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!resp.ok) throw new Error(`GitHub API error: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// ─── Repositories ────────────────────────────────────────────────────────────

export async function listRepos(
  connectorId: string,
  perPage = 30,
): Promise<GitHubRepo[]> {
  return (await githubApi(connectorId, '/user/repos', {
    sort: 'updated',
    per_page: String(perPage),
    type: 'all',
  })) as GitHubRepo[];
}

export async function getRepoReadme(
  connectorId: string,
  owner: string,
  repo: string,
): Promise<string> {
  const token = await getValidToken(connectorId);

  const resp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
    },
  });

  if (!resp.ok) {
    if (resp.status === 404) return '';
    throw new Error(`GitHub README error: ${resp.status}`);
  }

  return resp.text();
}

// ─── Issues ──────────────────────────────────────────────────────────────────

export async function listIssues(
  connectorId: string,
  owner: string,
  repo: string,
  state = 'all',
  perPage = 30,
): Promise<GitHubIssue[]> {
  return (await githubApi(connectorId, `/repos/${owner}/${repo}/issues`, {
    state,
    per_page: String(perPage),
    sort: 'updated',
    direction: 'desc',
  })) as GitHubIssue[];
}

// ─── Pull Requests ───────────────────────────────────────────────────────────

export async function listPRs(
  connectorId: string,
  owner: string,
  repo: string,
  state = 'all',
  perPage = 30,
): Promise<GitHubPR[]> {
  return (await githubApi(connectorId, `/repos/${owner}/${repo}/pulls`, {
    state,
    per_page: String(perPage),
    sort: 'updated',
    direction: 'desc',
  })) as GitHubPR[];
}

// ─── Text Conversion ─────────────────────────────────────────────────────────

export function repoToText(repo: GitHubRepo, readme: string): string {
  const parts = [
    `Repository: ${repo.full_name}`,
    repo.description ? `Description: ${repo.description}` : '',
    repo.language ? `Language: ${repo.language}` : '',
    repo.topics.length > 0 ? `Topics: ${repo.topics.join(', ')}` : '',
    `Stars: ${repo.stargazers_count}`,
    `URL: ${repo.html_url}`,
    `Last Updated: ${repo.updated_at}`,
    '',
    readme ? `README:\n${readme}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

export function issuesToText(issues: GitHubIssue[], repoName: string): string {
  const header = `Issues for ${repoName} (${issues.length} issues)\n`;
  const items = issues.map((i) => {
    const labels = i.labels.map((l) => l.name).join(', ');
    return [
      `#${i.number}: ${i.title} [${i.state}]`,
      `  Author: ${i.user.login} | Created: ${i.created_at}`,
      labels ? `  Labels: ${labels}` : '',
      i.body ? `  ${i.body.slice(0, 500)}` : '',
    ].filter(Boolean).join('\n');
  });
  return header + items.join('\n\n');
}

export function prsToText(prs: GitHubPR[], repoName: string): string {
  const header = `Pull Requests for ${repoName} (${prs.length} PRs)\n`;
  const items = prs.map((pr) => {
    return [
      `#${pr.number}: ${pr.title} [${pr.state}]`,
      `  Author: ${pr.user.login} | ${pr.head.ref} → ${pr.base.ref}`,
      pr.merged_at ? `  Merged: ${pr.merged_at}` : `  Created: ${pr.created_at}`,
      pr.body ? `  ${pr.body.slice(0, 500)}` : '',
    ].filter(Boolean).join('\n');
  });
  return header + items.join('\n\n');
}
