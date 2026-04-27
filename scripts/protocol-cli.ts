#!/usr/bin/env node
/**
 * DNA Protocol CLI — Query protocol paradigms (git/CI/deploy levels).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { DNA_DATA, parseFrontmatter, resolveAgentWorkspace } from '../lib/common.ts';
import { buildGraph, getNodesByType, nodeToEntry } from './mesh-cli.ts';

const PROTOCOL_DIR = path.join(DNA_DATA, 'protocols');
const INJECT_CHAR_LIMIT = 2000;

interface ProtocolEntry {
  meta: Record<string, any>;
  body: string;
  filePath: string;
}

function loadProtocols(): ProtocolEntry[] {
  const graph = buildGraph();
  const nodes = getNodesByType(graph, 'protocol');
  // Sort by id+".md" to match legacy readdirSync().sort() filename order
  nodes.sort((a, b) => {
    const ai = (a.fields.id || '').toString() + '.md';
    const bi = (b.fields.id || '').toString() + '.md';
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  return nodes.map(n => ({
    meta: { ...n.fields, id: n.fields.id || n.id },
    body: n._body ?? '',
    filePath: n.path,
  }));
}

function cmdList() {
  const entries = loadProtocols();
  if (!entries.length) { console.log('No protocols found.'); return; }
  console.log(`📡 Protocol Paradigms — ${entries.length} entries\n`);
  const col = Math.max(...entries.map(e => (e.meta.id || '').length)) + 2;
  console.log(`${'ID'.padEnd(col)} Title`);
  console.log('-'.repeat(col + 50));
  for (const e of entries) {
    console.log(`${(e.meta.id || '?').padEnd(col)} ${e.meta.title || '?'}`);
  }
}

function cmdShow(entryId: string) {
  const entries = loadProtocols();
  const e = entries.find(e => (e.meta.id || '').toLowerCase() === entryId.toLowerCase());
  if (!e) { console.error(`❌ Protocol not found: ${entryId}`); process.exit(1); }
  console.log(e.body);
}

function cmdInject(entryId: string) {
  const entries = loadProtocols();
  const e = entries.find(e => (e.meta.id || '').toLowerCase() === entryId.toLowerCase());
  if (!e) { console.error(`❌ Protocol not found: ${entryId}`); process.exit(1); }

  const eid = e.meta.id || entryId;
  const title = e.meta.title || entryId;
  const summary = e.meta.summary || '';

  if (summary) {
    console.log(`<!-- PROTOCOL:${eid} -->`);
    console.log(`**📡 ${eid}** *(summary)*: ${summary}`);
    console.log(`\n> 📖 *Full text*: \`dna protocol ${eid}\``);
    console.log(`<!-- /PROTOCOL:${eid} -->`);
    return;
  }

  let output = `<!-- PROTOCOL:${eid} -->\n## 📡 ${eid}: ${title}\n\n${e.body}\n<!-- /PROTOCOL:${eid} -->`;
  if (output.length > INJECT_CHAR_LIMIT) {
    let truncated = output.slice(0, INJECT_CHAR_LIMIT);
    const lastNl = truncated.lastIndexOf('\n');
    if (lastNl > INJECT_CHAR_LIMIT / 2) truncated = truncated.slice(0, lastNl);
    truncated += `\n\n⚠️ TRUNCATED — protocol '${eid}' exceeds ${INJECT_CHAR_LIMIT} char inject limit. Run \`dna protocol ${eid}\` for full text.`;
    truncated += `\n<!-- /PROTOCOL:${eid} -->`;
    console.log(truncated);
  } else {
    console.log(output);
  }
}

function cmdAgent(agentId: string) {
  const workspace = resolveAgentWorkspace(agentId);
  if (!workspace) { console.error(`❌ Agent '${agentId}' not found in openclaw.json`); process.exit(1); }

  const dnaPath = existsSync(path.join(workspace, 'dna.yml'))
    ? path.join(workspace, 'dna.yml')
    : path.join(workspace, 'dna.yaml');
  if (!fs.existsSync(dnaPath)) { console.log(`⚠️  Agent '${agentId}' has no protocol: field in dna.yaml`); return; }

  const content = fs.readFileSync(dnaPath, 'utf-8');
  const data = yaml.load(content) as Record<string, any> | null;
  const protocol = data?.protocol || data?.architecture || data?.workflow;
  if (!protocol) { console.log(`⚠️  Agent '${agentId}' has no protocol: field in dna.yaml`); return; }

  console.log(`📡 ${agentId} → protocol: ${protocol}`);
  const entries = loadProtocols();
  const e = entries.find(e => (e.meta.id || '').toLowerCase() === String(protocol).toLowerCase());
  if (e) {
    const summary = e.meta.summary || '';
    if (summary) console.log(`\n   ${summary}`);
  } else {
    console.log(`\n   ⚠️  Protocol '${protocol}' not found in protocol definitions`);
  }
}

function cmdSearch(query: string) {
  const entries = loadProtocols();
  const q = query.toLowerCase();
  const results = entries.filter(e => {
    const s = `${e.meta.title || ''} ${e.body} ${e.meta.summary || ''} ${e.meta.tags || ''}`.toLowerCase();
    return s.includes(q);
  });
  if (!results.length) { console.log(`No protocols matching '${query}'`); return; }
  console.log(`🔍 ${results.length} protocols matching '${query}':\n`);
  for (const e of results) {
    console.log(`  ${e.meta.id || '?'}: ${e.meta.title || '?'}`);
  }
}

function slugToTitle(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function cmdAddProtocol(slug: string) {
  const filePath = path.join(PROTOCOL_DIR, `${slug}.dna`);
  const legacyPath = path.join(PROTOCOL_DIR, `${slug}.md`);
  if (fs.existsSync(filePath) || fs.existsSync(legacyPath)) { console.error(`❌ Protocol already exists: ${slug}`); process.exit(1); }
  const template = `---\nid: ${slug}\ntitle: "${slugToTitle(slug)}"\ntags: []\n---\n\n# ${slug}\n\n## Description\n\n(describe the protocol here)\n`;
  fs.writeFileSync(filePath, template, 'utf-8');
  const editor = process.env.EDITOR || 'vi';
  execSync(`${editor} ${filePath}`, { stdio: 'inherit' });
  console.log(`✅ Created: ${filePath}`);
}

function cmdEditProtocol(slug: string) {
  const filePath = fs.existsSync(path.join(PROTOCOL_DIR, `${slug}.dna`)) ? path.join(PROTOCOL_DIR, `${slug}.dna`) : path.join(PROTOCOL_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) { console.error(`❌ Protocol not found: ${slug}`); process.exit(1); }
  const editor = process.env.EDITOR || 'vi';
  execSync(`${editor} ${filePath}`, { stdio: 'inherit' });
}

function cmdRmProtocol(slug: string) {
  const filePath = fs.existsSync(path.join(PROTOCOL_DIR, `${slug}.dna`)) ? path.join(PROTOCOL_DIR, `${slug}.dna`) : path.join(PROTOCOL_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) { console.error(`❌ Protocol not found: ${slug}`); process.exit(1); }
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
  console.log(`DNA Protocol CLI

Usage:
  dna protocol --list                List all protocol paradigms
  dna protocol <slug>                Show full protocol definition
  dna protocol --inject <slug>       Injectable format
  dna protocol --search <query>      Search protocols
  dna protocol --agent <id>          Show agent's assigned protocol
  dna protocol --add <slug>          Create new protocol (opens in $EDITOR)
  dna protocol --edit <slug>         Edit existing protocol in $EDITOR
  dna protocol --rm <slug>           Trash a protocol`);
} else if (args[0] === '--list') {
  cmdList();
} else if (args[0] === '--agent' && args[1]) {
  cmdAgent(args[1]);
} else if (args[0] === '--inject' && args[1]) {
  cmdInject(args[1]);
} else if (args[0] === '--search' && args[1]) {
  cmdSearch(args.slice(1).join(' '));
} else if (args[0] === '--add' && args[1]) {
  cmdAddProtocol(args[1]);
} else if (args[0] === '--edit' && args[1]) {
  cmdEditProtocol(args[1]);
} else if (args[0] === '--rm' && args[1]) {
  cmdRmProtocol(args[1]);
} else {
  cmdShow(args[0]);
}
