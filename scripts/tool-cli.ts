#!/usr/bin/env node
/**
 * dna tool — DNA Toolbox
 * Invoke registered CLI tools or read their GBTD-S specs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { DNA_DATA } from '../lib/common.ts';

const TOOLS_YAML = path.join(DNA_DATA, 'tools.yaml');
const SPEC_CLI = path.join(path.dirname(new URL(import.meta.url).pathname), 'spec-cli.ts');
const SPEC_FLAGS = new Set(['--spec', '--goal', '--boundary', '--tools', '--deprecated', '--tree', '--json', '--skill']);

interface ToolConfig {
  description?: string;
  repo?: string;
  bin?: string;
  skill?: string;
}

function loadTools(): Record<string, ToolConfig> {
  if (!fs.existsSync(TOOLS_YAML)) {
    console.error(`❌ tools.yaml not found: ${TOOLS_YAML}`);
    process.exit(1);
  }
  const data = yaml.load(fs.readFileSync(TOOLS_YAML, 'utf-8')) as any;
  return data?.tools || {};
}

function listTools(tools: Record<string, ToolConfig>) {
  console.log('🧰 DNA Toolbox\n');
  const names = Object.keys(tools).sort();
  if (!names.length) { console.log('  (no tools registered)'); return; }
  const maxName = Math.max(...names.map(n => n.length));
  for (const name of names) {
    const cfg = tools[name];
    const desc = cfg.description || '(no description)';
    console.log(`  ${name.padEnd(maxName + 2)} ${desc}`);
    if (cfg.repo) console.log(`  ${' '.repeat(maxName + 2)} repo: ${cfg.repo}`);
  }
  console.log('\nUsage:');
  console.log('  dna tool <name> <args...>    Invoke CLI');
  console.log('  dna tool <name> --spec       Read spec document');
  console.log('  dna tool <name>              Show GBTD');
}

function showToolSkill(toolName: string, cfg: ToolConfig) {
  const skillVal = cfg.skill;
  if (!skillVal) {
    console.error(`❌ No skill found for tool '${toolName}'.`);
    console.error(`   Add a 'skill' field to tools.yaml to register one.`);
    process.exit(1);
  }
  let p = path.resolve(skillVal.replace(/^~/, process.env.HOME!));
  if (fs.existsSync(p) && fs.statSync(p).isFile() && path.basename(p) === 'SKILL.md') {
    console.log(fs.readFileSync(p, 'utf-8'));
    return;
  }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const skillMd = path.join(p, 'SKILL.md');
    if (fs.existsSync(skillMd)) { console.log(fs.readFileSync(skillMd, 'utf-8')); return; }
    console.error(`❌ Skill directory exists but no SKILL.md found: ${p}`);
    process.exit(1);
  }
  console.error(`❌ Skill path not found: ${p}`);
  process.exit(1);
}

const HELP = `dna tool — DNA Toolbox

Usage:
    dna tool ls                          List registered tools
    dna tool <name> <args...>            Invoke tool CLI
    dna tool <name>                      Show GBTD
    dna tool <name> --spec               Show spec document
    dna tool <name> --skill              Show bundled skill`;

const args = process.argv.slice(2);
if (!args.length || ['-h', '--help', 'help'].includes(args[0])) {
  console.log(HELP);
  process.exit(0);
}

const tools = loadTools();

if (args[0] === 'ls') {
  listTools(tools);
  process.exit(0);
}

const toolName = args[0];
const rest = args.slice(1);

if (!(toolName in tools)) {
  console.error(`❌ Unknown tool: ${toolName}`);
  console.error(`   Available: ${Object.keys(tools).sort().join(', ')}`);
  process.exit(1);
}

const cfg = tools[toolName];

if (rest.includes('--skill')) {
  showToolSkill(toolName, cfg);
  process.exit(0);
}

const hasSpecFlag = rest.some(f => SPEC_FLAGS.has(f));

if (!rest.length || hasSpecFlag) {
  if (!cfg.repo) { console.error(`❌ Tool '${toolName}' has no repo configured.`); process.exit(1); }
  const specFlags = rest.filter(f => SPEC_FLAGS.has(f));
  // Delegate to spec-cli (could be .ts or .py)
  const specCliPy = path.join(DNA_DATA, 'scripts', 'spec-cli.py');
  try {
    const result = execFileSync('python3', [specCliPy, '--repo', cfg.repo, ...specFlags], { stdio: 'inherit' });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

// Invoke the CLI
if (!cfg.bin) { console.error(`❌ Tool '${toolName}' has no bin configured.`); process.exit(1); }
const parts = cfg.bin.split(/\s+/);
try {
  execFileSync(parts[0], [...parts.slice(1), ...rest], { stdio: 'inherit' });
} catch (e: any) {
  process.exit(e.status || 1);
}
