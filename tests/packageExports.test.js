import assert from 'node:assert/strict';
import test from 'node:test';

import * as documentApi from '../src/document.js';
import * as editorApi from '../src/editor.js';
import * as imageApi from '../src/images.js';
import * as solverApi from '../src/solver.js';

test('standalone package entry points expose the reusable ParaMagic APIs', () => {
  assert.equal(typeof documentApi.parseParamagicDocument, 'function');
  assert.equal(typeof editorApi.createInfiniteCanvas, 'function');
  assert.equal(typeof imageApi.configureOpenCvResources, 'function');
  assert.equal(typeof solverApi.createSolverExecutionFacade, 'function');
});
