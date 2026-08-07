import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert';

const dna = (args: string[]) =>
  execFileSync('dna', args, { encoding: 'utf-8', timeout: 15000 });

describe('dna CLI smoke tests', () => {
  it('dna help exits 0', () => {
    const out = dna(['help']);
    assert.ok(out.includes('Agentic DNA'));
  });

  it('dna philosophy --list exits 0 and contains header', () => {
    const out = dna(['philosophy', '--list']);
    assert.ok(out.includes('Philosophy Database'));
  });

  it('dna convention --list exits 0', () => {
    dna(['convention', '--list']);
  });

  it('dna tool ls exits 0', () => {
    const out = dna(['tool', 'ls']);
    assert.ok(out.includes('Toolbox'));
  });

  it('dna tool --inject emits compact global context including roblocks', () => {
    const out = dna(['tool', '--inject']);
    assert.match(out, /DNA Toolbox \(global\)/);
    assert.match(out, /- roblocks: .*credential/i);
    assert.ok(out.length < 2000, `tool injection should stay compact, got ${out.length} chars`);
  });

  it('base injection expands the toolbox directive', () => {
    const base = `${process.env.HOME}/.openclaw/.dna/injections/base.dna`;
    const out = dna(['hydrate', base, '--stdio']);
    assert.match(out, /DNA Toolbox \(global\)/);
    assert.match(out, /- roblocks: .*credential/i);
    assert.doesNotMatch(out, /\{\{dna tool --inject\}\}/);
  });

  it('dna distill help exits 0', () => {
    const out = dna(['distill', 'help']);
    assert.ok(out.includes('DNA Distill'));
    assert.ok(out.includes('dna-markdown'));
  });
});
