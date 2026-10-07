import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackendHost, modelValue, parseProfileValue, resolveJobExecution, sendToAI } from '../src/backends';
import { DEFAULT_SETTINGS, normalizeJob } from '../src/settings';
import { AISettings } from '../src/types';

// Timers in the plugin go through `window` (the renderer); Node only has globalThis.
(globalThis as unknown as { window?: typeof globalThis }).window ??= globalThis;

/** A fake Obsidian Copilot whose chain resolves after `delayMs`, tracking overlap. */
function copilotHost(delayMs = 20) {
	const stats = { active: 0, maxActive: 0, aborted: 0 };
	const copilot = {
		chatManager: {
			sendMessage: async () => 'message-id',
			getLLMMessage: () => ({}),
		},
		chainOwner: {
			getCurrentChainManager: () => ({
				runChain: async (_message: unknown, abort: AbortController, _onUpdate: unknown, onDone: (message: unknown) => void) => {
					stats.active++;
					stats.maxActive = Math.max(stats.maxActive, stats.active);
					abort.signal.addEventListener('abort', () => { stats.aborted++; });
					await new Promise(resolve => setTimeout(resolve, delayMs));
					stats.active--;
					onDone({ content: 'reply' });
				},
			}),
		},
	};
	const settings: AISettings = { ...DEFAULT_SETTINGS, backendMode: 'copilot' };
	const host = { app: { plugins: { plugins: { copilot } }, vault: { getAbstractFileByPath: () => null } }, settings } as unknown as BackendHost;
	return { host, stats };
}

test('sendToAI runs backend sends one at a time', async () => {
	const { host, stats } = copilotHost();
	const replies = await Promise.all([sendToAI(host, 'a'), sendToAI(host, 'b'), sendToAI(host, 'c')]);
	assert.deepEqual(replies, ['reply', 'reply', 'reply']);
	assert.equal(stats.maxActive, 1, 'sends overlapped');
});

test('a send cancelled while queued never starts, and later sends still run', async () => {
	const { host, stats } = copilotHost(30);
	const controller = new AbortController();
	const first = sendToAI(host, 'first');
	const cancelled = sendToAI(host, 'cancelled', {}, null, controller.signal);
	controller.abort();
	await first;
	await assert.rejects(cancelled, /Cancelled/);
	assert.equal(await sendToAI(host, 'after'), 'reply');
	assert.equal(stats.maxActive, 1);
});

test('aborting a running send aborts the Copilot chain', async () => {
	const { host, stats } = copilotHost(40);
	const controller = new AbortController();
	const running = sendToAI(host, 'x', {}, null, controller.signal);
	await new Promise(resolve => setTimeout(resolve, 10));
	controller.abort();
	await running;
	assert.equal(stats.aborted, 1);
});

test('the periodic review uses the review model; other jobs use the task model', async () => {
	const settings: AISettings = { ...DEFAULT_SETTINGS, backendMode: 'claudian', executionModel: '', nightlyReviewModel: 'claude::review-model' };
	const host = { app: { plugins: { plugins: {} } }, settings } as unknown as BackendHost;
	const review = normalizeJob({ id: 'periodic-vault-review', routine: 'periodic-review', title: 'Review', prompt: '', schedule: { kind: 'daily', time: '22:00' } });
	const task = normalizeJob({ title: 'Task', prompt: 'p', schedule: { kind: 'daily', time: '09:00' } });
	// The review has a model, so it gets past model selection (and fails on the missing plugin).
	await assert.rejects(resolveJobExecution(host, review), /not installed or enabled/);
	await assert.rejects(resolveJobExecution(host, task), /No model selected for scheduled task execution/);
});

test('model profile values round-trip', () => {
	assert.deepEqual(parseProfileValue(modelValue('claude', 'sonnet')), { providerId: 'claude', model: 'sonnet' });
});
