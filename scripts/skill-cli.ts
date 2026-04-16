#!/usr/bin/env node
/**
 * dna skill — Manual skill operations.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { DNA_DATA } from '../lib/common.ts';

const DEFAULT_ROOT = path.join(process.env.HOME!, '.openclaw', 'skills-manual');
const CONFIG_FILE = path.join(DEFAULT_ROOT, 'roots.json');

function loadRoots(): string[] {
  const roots = [DEFAULT_ROOT];
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const p of data) {
          const expanded = path.resolve(p.replace(/^~/, process.env.HOME!));
          if (!roots.includes(expanded) && fs.existsSync(expanded)) roots.push(expanded);
        }
      }
    } catch {}
  }
  return roots;
}

function allSkills(): Array<[string, string]> {
  const seen = new Map<string, string>();
  for (const root of loadRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root).sort()) {
      const full = path.join(root, d);
      if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'SKILL.md')) && !seen.has(d)) {
        seen.set(d, full);
      }
    }
  }
  return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function getDescription(skillPath: string): string {
  const md = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(md)) return '(no SKILL.md)';
  try {
    const text = fs.readFileSync(md, 'utf-8');
    const m = text.match(/^description:\s*["']?(.*?)["']?\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    const m2 = text.match(/description:\s*"([^"]*)"/);
    if (m2) return m2[1].trim();
  } catch {}
  return '(no description)';
}

function findSkill(name: string): string | null {
  for (const root of loadRoots()) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  return null;
}

function toolSkills(): Array<[string, string]> {
  const toolsYaml = path.join(DNA_DATA, 'tools.yaml');
  if (!fs.existsSync(toolsYaml)) return [];
  try {
    const data = yaml.load(fs.readFileSync(toolsYaml, 'utf-8')) as any;
    const tools = data?.tools || {};
    const results: Array<[string, string]> = [];
    for (const [name, cfg] of Object.entries(tools).sort()) {
      if (typeof cfg !== 'object' || !cfg) continue;
      const skillPath = (cfg as any).skill;
      if (!skillPath) continue;
      let p = path.resolve(String(skillPath).replace(/^~/, process.env.HOME!));
      if (fs.existsSync(p) && fs.statSync(p).isFile() && path.basename(p) === 'SKILL.md') p = path.dirname(p);
      if (fs.existsSync(p) && fs.existsSync(path.join(p, 'SKILL.md'))) results.push([`tool:${name}`, p]);
    }
    return results;
  } catch { return []; }
}

function cmdLs() {
  const skills = allSkills();
  if (!skills.length) { console.log('No manual skills found.'); return; }
  console.log(`📖 Manual skills (${skills.length}):\n`);
  const maxName = Math.max(...skills.map(([n]) => n.length));
  for (const [name, p] of skills) {
    let desc = getDescription(p);
    if (desc.length > 80) desc = desc.slice(0, 77) + '...';
    console.log(`  ${name.padEnd(maxName)}  ${desc}`);
  }
  const roots = loadRoots();
  if (roots.length > 1) {
    console.log(`\n📁 Skill roots (${roots.length}):`);
    for (const r of roots) console.log(`  ${r}`);
  }
  const ts = toolSkills();
  if (ts.length) {
    console.log(`\n🧰 Tool-bundled skills (${ts.length}):`);
    const maxTs = Math.max(...ts.map(([n]) => n.length));
    for (const [name, p] of ts) {
      let desc = getDescription(p);
      if (desc.length > 80) desc = desc.slice(0, 77) + '...';
      console.log(`  ${name.padEnd(maxTs)}  ${desc}`);
    }
    console.log(`\n  Use 'dna tool <name> --skill' to read.`);
  }
}

function cmdRead(name: string, showRefs: boolean) {
  const sp = findSkill(name);
  if (!sp) {
    console.error(`Skill '${name}' not found across skill roots`);
    const matches = allSkills().filter(([n]) => n.toLowerCase().includes(name.toLowerCase())).map(([n]) => n);
    if (matches.length) console.error(`Did you mean: ${matches.join(', ')}?`);
    process.exit(1);
  }
  console.log(fs.readFileSync(path.join(sp, 'SKILL.md'), 'utf-8'));
  if (showRefs) {
    let hasExtras = false;
    const refsDir = path.join(sp, 'references');
    if (fs.existsSync(refsDir)) {
      const refs = fs.readdirSync(refsDir).filter(f => f.endsWith('.md')).sort();
      if (refs.length) { hasExtras = true; console.log('\n---\n📚 References:'); refs.forEach(r => console.log(`  ${r}`)); }
    }
    const scriptsDir = path.join(sp, 'scripts');
    if (fs.existsSync(scriptsDir)) {
      const scripts = fs.readdirSync(scriptsDir).filter(f => !f.startsWith('.') && f !== '__pycache__').sort();
      if (scripts.length) { hasExtras = true; console.log('\n🔧 Scripts:'); scripts.forEach(s => console.log(`  ${s}`)); }
    }
    if (!hasExtras) console.log('\n(no references or scripts)');
  }
}

function cmdReadRef(name: string, ref: string) {
  const sp = findSkill(name);
  if (!sp) { console.error(`Skill '${name}' not found`); process.exit(1); }
  for (const subdir of ['references', 'scripts', '']) {
    const p = subdir ? path.join(sp, subdir, ref) : path.join(sp, ref);
    if (fs.existsSync(p)) { console.log(fs.readFileSync(p, 'utf-8')); return; }
  }
  for (const subdir of ['references', 'scripts']) {
    const p = path.join(sp, subdir, `${ref}.md`);
    if (fs.existsSync(p)) { console.log(fs.readFileSync(p, 'utf-8')); return; }
  }
  console.error(`Reference '${ref}' not found in skill '${name}'`);
  process.exit(1);
}

function cmdSearch(query: string) {
  const q = query.toLowerCase();
  const results = allSkills().filter(([name, p]) => {
    const desc = getDescription(p);
    return name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
  });
  if (!results.length) { console.log(`No skills matching '${query}'`); return; }
  console.log(`🔍 ${results.length} skill(s) matching '${query}':\n`);
  const maxName = Math.max(...results.map(([n]) => n.length));
  for (const [name, p] of results) {
    let desc = getDescription(p);
    if (desc.length > 80) desc = desc.slice(0, 77) + '...';
    console.log(`  ${name.padEnd(maxName)}  ${desc}`);
  }
}

function cmdRoots() {
  const roots = loadRoots();
  console.log(`📁 Skill roots (${roots.length}):`);
  roots.forEach((r, i) => {
    const tag = i === 0 ? ' (default)' : '';
    const exists = fs.existsSync(r) ? '✓' : '✗';
    let count = 0;
    if (fs.existsSync(r)) count = fs.readdirSync(r).filter(d => fs.statSync(path.join(r, d)).isDirectory() && fs.existsSync(path.join(r, d, 'SKILL.md'))).length;
    console.log(`  ${exists} ${r}${tag}  (${count} skills)`);
  });
}

function cmdAddRoot(pathStr: string) {
  const newRoot = path.resolve(pathStr.replace(/^~/, process.env.HOME!));
  if (!fs.existsSync(newRoot) || !fs.statSync(newRoot).isDirectory()) {
    console.error(`Directory does not exist: ${newRoot}`); process.exit(1);
  }
  let existing: string[] = [];
  if (fs.existsSync(CONFIG_FILE)) { try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { existing = []; } }
  const resolved = existing.map(p => path.resolve(p.replace(/^~/, process.env.HOME!)));
  if (resolved.includes(newRoot) || newRoot === path.resolve(DEFAULT_ROOT)) { console.log(`Root already registered: ${newRoot}`); return; }
  existing.push(newRoot);
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2) + '\n');
  console.log(`✓ Added skill root: ${newRoot}`);
}

function cmdRemoveRoot(pathStr: string) {
  const target = path.resolve(pathStr.replace(/^~/, process.env.HOME!));
  if (target === path.resolve(DEFAULT_ROOT)) { console.error('Cannot remove the default skill root.'); process.exit(1); }
  if (!fs.existsSync(CONFIG_FILE)) { console.error(`Root not found: ${target}`); process.exit(1); }
  let existing: string[];
  try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { console.error(`Root not found: ${target}`); process.exit(1); return; }
  const newList = existing.filter(p => path.resolve(p.replace(/^~/, process.env.HOME!)) !== target);
  if (newList.length === existing.length) { console.error(`Root not found: ${target}`); process.exit(1); }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(newList, null, 2) + '\n');
  console.log(`✓ Removed skill root: ${target}`);
}

const args = process.argv.slice(2);
if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
  console.log(`📖 dna skill — Manual skill operations

Usage:
  dna skill ls                      List all manual skills
  dna skill read <name>             Output skill content
  dna skill read <name> --refs      Also list references
  dna skill read-ref <name> <ref>   Output a reference file
  dna skill search <query>          Search by name/description
  dna skill roots                   Show registered skill roots
  dna skill add-root <path>         Register a new skill root
  dna skill remove-root <path>      Unregister a skill root`);
  const roots = loadRoots();
  console.log(`\nSkill roots (${roots.length}):`);
  for (const r of roots) console.log(`  ${r}`);
  process.exit(0);
}

const subcmd = args[0];
switch (subcmd) {
  case 'ls': cmdLs(); break;
  case 'read':
    if (!args[1]) { console.error('Usage: dna skill read <name> [--refs]'); process.exit(1); }
    cmdRead(args[1], args.includes('--refs'));
    break;
  case 'read-ref': case 'readref':
    if (!args[1] || !args[2]) { console.error('Usage: dna skill read-ref <name> <ref>'); process.exit(1); }
    cmdReadRef(args[1], args[2]);
    break;
  case 'search':
    if (!args[1]) { console.error('Usage: dna skill search <query>'); process.exit(1); }
    cmdSearch(args.slice(1).join(' '));
    break;
  case 'roots': cmdRoots(); break;
  case 'add-root': case 'addroot':
    if (!args[1]) { console.error('Usage: dna skill add-root <path>'); process.exit(1); }
    cmdAddRoot(args[1]);
    break;
  case 'remove-root': case 'rmroot':
    if (!args[1]) { console.error('Usage: dna skill remove-root <path>'); process.exit(1); }
    cmdRemoveRoot(args[1]);
    break;
  default:
    console.error(`Unknown skill subcommand: ${subcmd}`);
    console.error("Run 'dna skill help' for usage.");
    process.exit(1);
}
