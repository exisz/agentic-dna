#!/usr/bin/env node
/**
 * DNA Workflow CLI — Query workflow levels and agent workflow assignments.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { DNA_DATA, parseFrontmatter, resolveAgentWorkspace } from '../lib/common.ts';

const WORKFLOW_DIR = path.join(DNA_DATA, 'workflows');
const INJECT_CHAR_LIMIT = 2000;

interface WorkflowEntry {
  meta: Record<string, any>;
  body: string;
  filePath: string;
}

function loadWorkflows(): WorkflowEntry[] {
  if (!fs.existsSync(WORKFLOW_DIR)) return [];
  const entries: WorkflowEntry[] = [];
  for (const file of fs.readdirSync(WORKFLOW_DIR).sort()) {
    if (!file.endsWith('.md') || file === 'index.md') continue;
    const filePath = path.join(WORKFLOW_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const { meta, body } = parseFrontmatter(content);
    if (!meta.id) continue;
    entries.push({ meta, body, filePath });
  }
  return entries;
}

function cmdList() {
  const entries = loadWorkflows();
  if (!entries.length) { console.log('No workflows found.'); return; }
  console.log(`🔀 Workflow Levels — ${entries.length} entries\n`);
  const col = Math.max(...entries.map(e => (e.meta.id || '').length)) + 2;
  console.log(`${'ID'.padEnd(col)} Title`);
  console.log('-'.repeat(col + 50));
  for (const e of entries) {
    console.log(`${(e.meta.id || '?').padEnd(col)} ${e.meta.title || '?'}`);
  }
}

function cmdShow(entryId: string) {
  const entries = loadWorkflows();
  const e = entries.find(e => (e.meta.id || '').toLowerCase() === entryId.toLowerCase());
  if (!e) { console.error(`❌ Workflow not found: ${entryId}`); process.exit(1); }
  console.log(e.body);
}

function cmdInject(entryId: string) {
  const entries = loadWorkflows();
  const e = entries.find(e => (e.meta.id || '').toLowerCase() === entryId.toLowerCase());
  if (!e) { console.error(`❌ Workflow not found: ${entryId}`); process.exit(1); }

  const eid = e.meta.id || entryId;
  const title = e.meta.title || entryId;
  const summary = e.meta.summary || '';

  if (summary) {
    console.log(`<!-- WORKFLOW:${eid} -->`);
    console.log(`**🔀 ${eid}:** ${summary}`);
    console.log(`<!-- /WORKFLOW:${eid} -->`);
    return;
  }

  let output = `<!-- WORKFLOW:${eid} -->\n## 🔀 ${eid}: ${title}\n\n${e.body}\n<!-- /WORKFLOW:${eid} -->`;
  if (output.length > INJECT_CHAR_LIMIT) {
    let truncated = output.slice(0, INJECT_CHAR_LIMIT);
    const lastNl = truncated.lastIndexOf('\n');
    if (lastNl > INJECT_CHAR_LIMIT / 2) truncated = truncated.slice(0, lastNl);
    truncated += `\n\n⚠️ TRUNCATED — workflow '${eid}' exceeds ${INJECT_CHAR_LIMIT} char inject limit. Run \`dna workflow ${eid}\` for full text.`;
    truncated += `\n<!-- /WORKFLOW:${eid} -->`;
    console.log(truncated);
  } else {
    console.log(output);
  }
}

function cmdAgent(agentId: string) {
  const workspace = resolveAgentWorkspace(agentId);
  if (!workspace) { console.error(`❌ Agent '${agentId}' not found in openclaw.json`); process.exit(1); }

  const dnaPath = path.join(workspace, 'dna.yaml');
  if (!fs.existsSync(dnaPath)) { console.log(`⚠️  Agent '${agentId}' has no workflow: field in dna.yaml`); return; }

  const content = fs.readFileSync(dnaPath, 'utf-8');
  const data = yaml.load(content) as Record<string, any> | null;
  const workflow = data?.workflow;
  if (!workflow) { console.log(`⚠️  Agent '${agentId}' has no workflow: field in dna.yaml`); return; }

  console.log(`🔀 ${agentId} → workflow: ${workflow}`);
  const entries = loadWorkflows();
  const e = entries.find(e => (e.meta.id || '').toLowerCase() === String(workflow).toLowerCase());
  if (e) {
    const summary = e.meta.summary || '';
    if (summary) console.log(`\n   ${summary}`);
  } else {
    console.log(`\n   ⚠️  Workflow '${workflow}' not found in workflow definitions`);
  }
}

function cmdSearch(query: string) {
  const entries = loadWorkflows();
  const q = query.toLowerCase();
  const results = entries.filter(e => {
    const s = `${e.meta.title || ''} ${e.body} ${e.meta.summary || ''} ${e.meta.tags || ''}`.toLowerCase();
    return s.includes(q);
  });
  if (!results.length) { console.log(`No workflows matching '${query}'`); return; }
  console.log(`🔍 ${results.length} workflows matching '${query}':\n`);
  for (const e of results) {
    console.log(`  ${e.meta.id || '?'}: ${e.meta.title || '?'}`);
  }
}

function slugToTitle(slug: string): string {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function cmdAddWorkflow(slug: string) {
  const filePath = path.join(WORKFLOW_DIR, `${slug}.md`);
  if (fs.existsSync(filePath)) { console.error(`❌ Workflow already exists: ${slug}`); process.exit(1); }
  const template = `---\nid: ${slug}\ntitle: "${slugToTitle(slug)}"\ntags: []\n---\n\n# ${slug}\n\n## Description\n\n(describe the workflow here)\n`;
  fs.writeFileSync(filePath, template, 'utf-8');
  const editor = process.env.EDITOR || 'vi';
  execSync(`${editor} ${filePath}`, { stdio: 'inherit' });
  console.log(`✅ Created: ${filePath}`);
}

function cmdEditWorkflow(slug: string) {
  const filePath = path.join(WORKFLOW_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) { console.error(`❌ Workflow not found: ${slug}`); process.exit(1); }
  const editor = process.env.EDITOR || 'vi';
  execSync(`${editor} ${filePath}`, { stdio: 'inherit' });
}

function cmdRmWorkflow(slug: string) {
  const filePath = path.join(WORKFLOW_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) { console.error(`❌ Workflow not found: ${slug}`); process.exit(1); }
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
  console.log(`DNA Workflow CLI

Usage:
  dna workflow --list                List all workflow levels
  dna workflow <slug>                Show full workflow definition
  dna workflow --inject <slug>       Injectable format
  dna workflow --search <query>      Search workflows
  dna workflow --agent <id>          Show agent's assigned workflow
  dna workflow --add <slug>          Create new workflow (opens in $EDITOR)
  dna workflow --edit <slug>         Edit existing workflow in $EDITOR
  dna workflow --rm <slug>           Trash a workflow`);
} else if (args[0] === '--list') {
  cmdList();
} else if (args[0] === '--agent' && args[1]) {
  cmdAgent(args[1]);
} else if (args[0] === '--inject' && args[1]) {
  cmdInject(args[1]);
} else if (args[0] === '--search' && args[1]) {
  cmdSearch(args.slice(1).join(' '));
} else if (args[0] === '--add' && args[1]) {
  cmdAddWorkflow(args[1]);
} else if (args[0] === '--edit' && args[1]) {
  cmdEditWorkflow(args[1]);
} else if (args[0] === '--rm' && args[1]) {
  cmdRmWorkflow(args[1]);
} else {
  cmdShow(args[0]);
}
