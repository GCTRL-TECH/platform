#!/usr/bin/env node
// Regenerate the published copies of the GCTRL agent skill from the ONE source of truth,
// `MEMORY_SKILL_MD` in services/api-rs/src/routes/agent.rs:
//   sdk/claude-skill/gctrl/SKILL.md      Claude Code skill (frontmatter + body, verbatim)
//   services/portal/public/skill.md      static copy served at gctrl.tech/skill.md (ASCII dashes)
// The Rust test `skill_copies_carry_the_current_marker` (agent.rs) fails CI when a copy is
// behind the source, so a skill change is: edit the Rust const -> `node scripts/sync-skill.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rs = fs.readFileSync(path.join(root, 'services/api-rs/src/routes/agent.rs'), 'utf8');
const m = rs.match(/pub const MEMORY_SKILL_MD: &str = r#"([\s\S]*?)"#;/);
if (!m) throw new Error('MEMORY_SKILL_MD not found in agent.rs');
const body = m[1].replace(/\r\n/g, '\n');
const marker = body.match(/<!-- gctrl-skill-v\d+ -->/)?.[0];
if (!marker) throw new Error('skill marker missing');
const SOURCE = '<!-- Source of truth: services/api-rs/src/routes/agent.rs MEMORY_SKILL_MD. Keep in sync. -->\n\n';

// 1) Claude Code skill: keep its existing frontmatter, replace everything after it.
const sdkPath = path.join(root, 'sdk/claude-skill/gctrl/SKILL.md');
const sdk = fs.readFileSync(sdkPath, 'utf8').replace(/\r\n/g, '\n');
const fm = sdk.match(/^---\n[\s\S]*?\n---\n/);
if (!fm) throw new Error('SKILL.md frontmatter missing');
fs.writeFileSync(sdkPath, fm[0] + '\n' + SOURCE + body);

// 2) Portal copy: public prose is ASCII-only (no em/en dashes) - arrows stay.
const portalPath = path.join(root, 'services/portal/public/skill.md');
const ascii = body.replace(/—|–/g, '-');
fs.writeFileSync(portalPath, SOURCE + ascii);

console.log(`synced ${marker}: ${path.relative(root, sdkPath)}, ${path.relative(root, portalPath)}`);
