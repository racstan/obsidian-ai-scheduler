import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackendHost, checkCopilotSetup, claudianErrorFromReply, claudianName, configuredClaudianModels, copilotChatApi, getClaudianHost, getClaudianPlugin, getClaudianView, modelValue, parseProfileValue, resolveJobExecution, resolveModel, sendToAI } from '../src/backends';
import { DEFAULT_SETTINGS, normalizeJob } from '../src/settings';
import { AISettings, BackendMode } from '../src/types';

// Timers in the plugin go through `window` (the renderer); Node only has globalThis.
(globalThis as unknown as { window?: typeof globalThis }).window ??= globalThis;

/** A fake Copilot whose chain resolves after `delayMs`, tracking overlap. */
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

test('Claudian errors inside the reply are recognized, normal answers are not', () => {
	assert.equal(claudianErrorFromReply('\n\n❌ **Error:** Model "claude-x" is not available for this account'), 'Model "claude-x" is not available for this account');
	assert.equal(claudianErrorFromReply('**Error:** API key missing'), 'API key missing');
	assert.equal(claudianErrorFromReply('Here is your summary.\n\n- **Error:** handling section is fine'), null);
	assert.equal(claudianErrorFromReply('All done.'), null);
});

test('backend plugins are detected as enabled, installed-but-disabled, or missing', async () => {
	const { backendInstallState } = await import('../src/ui/backendBar');
	const app = (plugins: Record<string, unknown>, manifests: Record<string, unknown>) => ({ plugins: { plugins, manifests } }) as unknown as import('obsidian').App;
	assert.equal(backendInstallState(app({ realclaudian: {} }, { realclaudian: {} }), 'claudian'), 'enabled');
	assert.equal(backendInstallState(app({}, { copilot: {} }), 'copilot'), 'disabled');
	assert.equal(backendInstallState(app({}, {}), 'claudian'), 'missing');
});

test('Claudian models come from its enabled providers\' visible models, not stale settings', () => {
	const options = configuredClaudianModels({
		model: 'opencode:opencode-go/space-bunny-free', // removed in Claudian, still remembered here
		settingsProvider: 'opencode',
		savedProviderModel: { opencode: 'opencode:opencode-go/space-bunny-free' },
		providerConfigs: {
			claude: { enabled: false, visibleModels: [] },
			codex: { enabled: true, visibleModels: [] },
			opencode: { enabled: true, visibleModels: ['openrouter/openrouter/free'], selectedModels: [{ label: 'OpenRouter/Free Models Router', rawId: 'openrouter/openrouter/free' }] },
			pi: { enabled: false, visibleModels: ['pi:openrouter/openrouter/free'] },
		},
	});
	assert.deepEqual(options?.map(option => [option.providerId, option.model, option.label]), [
		['opencode', 'opencode:openrouter/openrouter/free', 'OpenCode / OpenRouter/Free Models Router'],
	]);
	assert.equal(parseProfileValue(options![0].value)?.model, 'opencode:openrouter/openrouter/free');
	// Aliases set in Claudian win, and older Claudian versions (no provider configs) fall back.
	assert.equal(configuredClaudianModels({ providerConfigs: { claude: { visibleModels: ['sonnet'], modelAliases: { sonnet: 'Sonnet (work)' } } } })?.[0].label, 'Claude / Sonnet (work)');
	assert.equal(configuredClaudianModels({ model: 'x' }), null);
});

test('Copilot 4.x: the chat API is found on chatUIState (issue #8)', async () => {
	const chatUIState = { sendMessage: async () => 'id', getLLMMessage: () => ({}) };
	const copilot = {
		chatUIState,
		chainOwner: { getCurrentChainManager: () => ({ runChain: async (_m: unknown, _a: unknown, _u: unknown, done: (m: unknown) => void) => { done({ content: 'v4 reply' }); } }) },
	};
	assert.equal(copilotChatApi(copilot), chatUIState);
	assert.equal(copilotChatApi({ chatManager: chatUIState }), chatUIState, 'Copilot 3.x still works');
	assert.equal(copilotChatApi({}), null);
	const settings: AISettings = { ...DEFAULT_SETTINGS, backendMode: 'copilot' };
	const host = { app: { plugins: { plugins: { copilot } }, vault: { getAbstractFileByPath: () => null } }, settings } as unknown as BackendHost;
	assert.equal(checkCopilotSetup(host).ok, true);
	assert.equal(await sendToAI(host, 'hello'), 'v4 reply');
});

/** A Claudian-family plugin in the given shape: old (functions on the plugin) or 2.3.2x (chatHost + workspace views). */
function claudianHost(mode: BackendMode, shape: 'old' | 'new', pluginId: string, viewType: string) {
	const manager = { getAllTabs: () => [{ id: 't1' }], getActiveTab: () => ({ id: 't1' }) };
	const view = shape === 'new' ? { tabManager: manager } : { getTabManager: () => manager };
	const created: Array<Record<string, unknown>> = [];
	const conversations = {
		createConversation: async (options: Record<string, unknown>) => { created.push(options); return { id: 'conv-1' }; },
		renameConversation: async () => undefined,
		getConversationSync: () => null,
	};
	const settings = { providerConfigs: { pi: { enabled: true, visibleModels: ['anthropic/claude'] } } };
	const plugin = shape === 'old'
		? { ...conversations, settings, getAllViews: () => [view], activateView: async () => undefined }
		: { settings, manifest: { id: pluginId }, chatHost: conversations };
	const leaves: Record<string, Array<{ view: unknown }>> = { [viewType]: [{ view }] };
	const app = {
		plugins: { plugins: { [pluginId]: plugin } },
		workspace: { getLeavesOfType: (type: string) => leaves[type] ?? [] },
	};
	const host = { app, settings: { ...DEFAULT_SETTINGS, backendMode: mode } } as unknown as BackendHost;
	return { host, plugin, view, created };
}

test('Claudian 2.3.2x: views come from the workspace, conversations from chatHost (issue #7)', async () => {
	const { host, plugin, view, created } = claudianHost('claudian', 'new', 'realclaudian', 'claudian-view');
	assert.equal(getClaudianPlugin(host), plugin);
	assert.equal(getClaudianHost(plugin as never), plugin.chatHost);
	assert.equal(await getClaudianView(host), view);
	const value = modelValue('pi', 'pi:anthropic/claude');
	assert.equal(configuredClaudianModels(plugin.settings as never)?.[0].value, value, 'Pi models get the pi: prefix');
	const execution = await resolveModel(host, value, 'a test');
	assert.equal(execution.conversationId, 'conv-1');
	assert.deepEqual(created, [{ providerId: 'pi', selectedModel: 'pi:anthropic/claude' }]);
});

test('Older Claudian (functions on the plugin) keeps working', async () => {
	const { host, plugin, view } = claudianHost('claudian', 'old', 'realclaudian', 'claudian-view');
	assert.equal(getClaudianHost(plugin as never), plugin);
	assert.equal(await getClaudianView(host), view);
});

test('Oh My Claudian is its own backend with its own plugin id and view (issue #6)', async () => {
	const { host, plugin, view } = claudianHost('oh-my-claudian', 'old', 'oh-my-claudian', 'oh-my-claudian-view');
	assert.equal(claudianName(host), 'Oh My Claudian');
	assert.equal(getClaudianPlugin(host), plugin);
	assert.equal(await getClaudianView(host), view);
	// Choosing Claudian does not pick up Oh My Claudian, and vice versa.
	const claudianOnly = claudianHost('claudian', 'old', 'oh-my-claudian', 'oh-my-claudian-view');
	assert.equal(getClaudianPlugin(claudianOnly.host), null);
});
