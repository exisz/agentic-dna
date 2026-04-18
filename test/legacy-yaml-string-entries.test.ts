/**
 * Regression test: convention-cli and flow-cli must not crash when
 * dna.yaml has string-array entries (workspace slug references) instead
 * of object-array entries.
 *
 * Reproduces: TypeError: Cannot read properties of undefined (reading 'toLowerCase')
 */
import { describe, it, before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import assert from 'node:assert';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dna-test-'));
  // Write a dna.yaml with string-array conventions and flows (slug references)
  fs.writeFileSync(
    path.join(tmpDir, 'dna.yaml'),
    `goal: test workspace\nconventions:\n  - sso-logto\n  - oss-release-playbook\nflows:\n  - oss-launch-zero-to-one\n`
  );
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const dna = (args: string[], cwd?: string) => {
  return execFileSync('dna', args, { encoding: 'utf-8', timeout: 15000, cwd: cwd || process.cwd() });
};

describe('legacy yaml string entries (slug references)', () => {
  it('convention --list does not crash with string-array conventions in dna.yaml', () => {
    // Should not throw TypeError: Cannot read properties of undefined
    assert.doesNotThrow(() => {
      dna(['convention', '--list'], tmpDir);
    });
  });

  it('convention show does not crash with string-array conventions in dna.yaml', () => {
    assert.doesNotThrow(() => {
      dna(['convention', 'oss-release-playbook'], tmpDir);
    });
  });

  it('flow --list does not crash with string-array flows in dna.yaml', () => {
    assert.doesNotThrow(() => {
      dna(['flow', '--list'], tmpDir);
    });
  });
});
