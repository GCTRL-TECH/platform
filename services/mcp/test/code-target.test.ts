import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeIndexTarget } from '../src/code-target.js';

test('explicit compilationId wins over every env default', () => {
  assert.deepEqual(
    codeIndexTarget('comp_explicit', { GCTRL_CODE_COMPILATION_ID: 'comp_env', GCTRL_CODE_FOLDER: 'Users/x/Code' }),
    { compilationId: 'comp_explicit' },
  );
});

test('GCTRL_CODE_COMPILATION_ID pins the target when the caller passes none', () => {
  assert.deepEqual(codeIndexTarget(undefined, { GCTRL_CODE_COMPILATION_ID: ' comp_env ' }), { compilationId: 'comp_env' });
  // An id beats a folder: a project session must never spawn a second graph elsewhere.
  assert.deepEqual(
    codeIndexTarget(undefined, { GCTRL_CODE_COMPILATION_ID: 'comp_env', GCTRL_CODE_FOLDER: 'Users/x/Code' }),
    { compilationId: 'comp_env' },
  );
});

test('GCTRL_CODE_FOLDER becomes folder segments for the auto-created compilation', () => {
  assert.deepEqual(codeIndexTarget(undefined, { GCTRL_CODE_FOLDER: 'Users/thomaskitsche/Code' }), {
    folderPath: ['Users', 'thomaskitsche', 'Code'],
  });
  // Tolerates sloppy input: leading/trailing slashes, blanks, doubled separators.
  assert.deepEqual(codeIndexTarget(undefined, { GCTRL_CODE_FOLDER: ' /Projects/ACME//Shop/Code/ ' }), {
    folderPath: ['Projects', 'ACME', 'Shop', 'Code'],
  });
});

test('nothing set -> empty target (server default Users/<owner>/Code applies)', () => {
  assert.deepEqual(codeIndexTarget(undefined, {}), {});
  assert.deepEqual(codeIndexTarget('', { GCTRL_CODE_COMPILATION_ID: '', GCTRL_CODE_FOLDER: '  ' }), {});
});
