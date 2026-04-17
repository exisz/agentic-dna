#!/usr/bin/env node
/**
 * DNA Architecture CLI — Query architecture paradigms (git/CI/deploy levels).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { DNA_DATA, parseFrontmatter, resolveAgentWorkspace } from '../lib/common.ts';

const ARCHITECTURE_DIR = path.join(DNA_DATA, 'architectures');
const INJECT_CHAR_LIMIT = 2000;

interface ArchitectureEntry {
  meta: Record<string, any>;
  body: string;
  filePath: string;
}

function loadArchitectures(): ArchitectureEntry[] {
  if (!fs.existsSync(ARCHITECTURE_DIR)) return [];
  const entries: ArchitectureEntry[] = [];
  for (const file of fs.readdirSync(ARCHITECTURE_DIR).sort()) {
    if (!file.endsWith('.md') || file === 'index.md') continue;
    const filePath = path.join(ARCHITECTURE_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { meta, body } = parseFrontmatter(content);
    if (!meta.id) continue;
    entries.push({ meta, body, filePath });
  }
  return entries;
}

function cmdList() {
  const entries = loadArchitectures();
  if (!entries.length) { console.log('No architectures found.'); return; }
  console.log(`🏗️  Architecture Paradigms — ${entries.length} entries\n`);
  const col = Math.max(...entries.map(e => (e.meta.id || '').length)) + 2;
  console.log(`${'ID'.padEnd(col)} Title`);
  console.log('-'.repeat(col + 50));
  for (const e of entries) {
    console.log(`${(e.meta.id || '?').padEnd(col)} ${e.meta.title || '?'}`);
  }
}

function cmdShow(entryId: string) {
  const entries = loadArchitectures();
  const e = entries.find(e => (e.meta.id || '').toLowerCase() === entryId.toLowerCase());
  if (!e) { console.error(`❌ Architecture not found: ${entryId}`); process.exit(1); }
  console.log(e.body);
}

function cmdInject(entryId: string) {
  const entries = loadArchitectures();
  const e = entries.find(e => (e.meta.id || '').toLowerCase() === entryId.toLowerCase());
  if (!e) { console.error(`❌ Architecture not found: ${entryId}`); process.exit(1); }

  const eid = e.meta.id || entryId;
  const title = e.meta.title || entryId;
  const summary = e.meta.summary || '';

  if (summary) {
    console.log(`<!-- ARCHITECTURE:${eid} -->`);
    console.log(`**🏗️  ${eid}:** ${summary}`);
    console.log(`<!-- /ARCHITECTURE:${eid} -->`);
    return;
  }

  let output = `<!-- ARCHITECTURE:${eid} -->\n## 🏗️  ${eid}: ${title}\n\n${e.body}\n<!-- /ARCHITECTURE:${eid} -->`;
  if (output.length > INJECT_CHAR_LIMIT) {
    let truncated = output.slice(0, INJECT_CHAR_LIMIT);
    const lastNl = truncated.lastIndexOf('\n');
    if (lastNl > INJECT_CHAR_LIMIT / 2) truncated = truncated.slice(0, lastNl);
    truncated += `\n\n⚠️ TRUNCATED — architecture '${eid}' exceeds ${INJECT_CHAR_LIMIT} char inject limit. Run \`dna architecture ${eid}\` for full text.`;
    truncated += `\n<!-- /ARCHITECTURE:${eid} -->`;
    console.log(truncated);
  } else {
    console.log(output);
  }
}

function cmdAgent(agentId: string) {
  const workspace = resolveAgentWorkspace(agentId);
  if (!workspace) { console.error(`❌ Agent '${agentId}' not found in openclaw.json`); process.exit(1); }

  const dnaPath = path.join(workspace, 'dna.yaml');
  if (!fs.existsSync(dnaPath)) { console.log(`⚠️  Agent '${agentId}' has no architecture: field in dna.yaml`); return; }

  const content = fs.readFileSync(dnaPath, 'utf-8');
  const data = yaml.load(content) as Record<string, any> | null;
  const architecture = data?.architecture || data?.workflow;
  if (!architecture) { console.log(`⚠️  Agent '${agentId}' has no architecture: field in dna.yaml`); return; }

  console.log(`🏗️  ${agentId} → architecture: ${architecture}`);
  const entries = loadArchitectures();
  const e = entries.find(e => (e.meta.id || '').toLowerCase() === String(architecture).toLowerCase());
  if (e) {
    const summary = e.meta.summary || '';
    if (summary) console.log(`\n   ${summary}`);
  } else {
    console.log(`\n   ⚠️  Architecture '${architecture}' not found in architecture definitions`);
  }
}

function cmdSearch(query: string) {
  const entries = loadArchitectures();
  const q = query.toLowerCase();
  const results = entries.filter(e => {
    const s = `${e.meta.title || ''} ${e.body} ${e.meta.summary || ''} ${e.meta.tags || ''}`.toLowerCase();
    return s.includes(q);
  });
  if (!results.length) { console.log(`No architectures matching '${query}'`); return; }
  console.log(`🔍 ${results.length} architectures matching '${query}':\n`);
  for (const e of results) {
    console.log(`  ${e.meta.id || '?'}: ${e.meta.title || '?'}`);
  }
}

function slugToTitle(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function cmdAddArchitecture(slug: string) {
  const filePath = path.join(ARCHITECTURE_DIR, `${slug}.md`);
  if (fs.existsSync(filePath)) { console.error(`❌ Architecture already exists: ${slug}`); process.exit(1); }
  const template = `---\nid: ${slug}\ntitle: "${slugToTitle(slug)}"\ntags: []\n---\n\n# ${slug}\n\n## Description\n\n(describe the architecture here)\n`;
  fs.writeFileSync(filePath, template, 'utf-8');
  const editor = process.env.EDITOR || 'vi';
  execSync(`${editor} ${filePath}`, { stdio: 'inherit' });
  console.log(`✅ Created: ${filePath}`);
}

function cmdEditArchitecture(slug: string) {
  const filePath = path.join(ARCHITECTURE_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) { console.error(`❌ Architecture not found: ${slug}`); process.exit(1); }
  const editor = process.env.EDITOR || 'vi';
  execSync(`${editor} ${filePath}`, { stdio: 'inherit' });
}

function cmdRmArchitecture(slug: string) {
  const filePath = path.join(ARCHITECTURE_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) { console.error(`❌ Architecture not found: ${slug}`); process.exit(1); }
  try {
    execSync('which trash', { stdio: 'ignore' });
    execSync(`trash ${filePath}`, { stdio: 'inherit' });
  } catch {
    execSync(`mv ${filePath} ~/.Trash/`, { stdio: 'inherit' });
  }
  console.log(`🗑️  Trashed: ${slug}`);
}

const args = process.argv.slice(2);
if (!args.length || args[0] === '--help' || args[0] === '-h') {
  console.log(`DNA Architecture CLI

Usage:
  dna architecture --list                List all architecture paradigms
  dna architecture <slug>                Show full architecture definition
  dna architecture --inject <slug>       Injectable format
  dna architecture --search <query>      Search architectures
  dna architecture --agent <id>          Show agent's assigned architecture
  dna architecture --add <slug>          Create new architecture (opens in $EDITOR)
  dna architecture --edit <slug>         Edit existing architecture in $EDITOR
  dna architecture --rm <slug>           Trash an architecture`);
} else if (args[0] === '--list') {
  cmdList();
} else if (args[0] === '--agent' && args[1]) {
  cmdAgent(args[1]);
} else if (args[0] === '--inject' && args[1]) {
  cmdInject(args[1]);
} else if (args[0] === '--search' && args[1]) {
  cmdSearch(args.slice(1).join(' '));
} else if (args[0] === '--add' && args[1]) {
  cmdAddArchitecture(args[1]);
} else if (args[0] === '--edit' && args[1]) {
  cmdEditArchitecture(args[1]);
} else if (args[0] === '--rm' && args[1]) {
  cmdRmArchitecture(args[1]);
} else {
  cmdShow(args[0]);
}
