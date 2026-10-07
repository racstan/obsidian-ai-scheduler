import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_UP_INSTRUCTION, contextPrompt, executionPrompt } from '../src/prompts';

test('execution prompts invite follow-ups only when allowed', () => {
	assert.ok(executionPrompt('Do it', []).includes(FOLLOW_UP_INSTRUCTION));
	assert.ok(!executionPrompt('Do it', [], false).includes(FOLLOW_UP_INSTRUCTION), 'follow-up jobs must not spawn more');
});

test('context prompts list the attached paths', () => {
	assert.equal(contextPrompt('Do it', []), 'Do it');
	const withPaths = contextPrompt('Do it', ['Projects/a.md', 'Notes']);
	assert.ok(withPaths.includes('- Projects/a.md') && withPaths.includes('- Notes'));
});
