/*
 * Backend integration for Claudian and Obsidian Copilot.
 *
 * Both backends are driven through their published plugin internals with
 * duck-typed guards, exactly like the original implementation: this plugin
 * never calls an AI provider and holds no API keys. Functions take the plugin
 * instance so the orchestration stays in main.ts.
 */
import { App, TFile, TFolder } from 'obsidian';
import { AISettings, BACKEND_INFO, Job } from './types';
import { JobContext } from './context';
import { contentFromMessage, errorText, isPeriodicReviewJob, sleep, withTimeout } from './util';

export const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ModelOption {
	value: string;
	label: string;
	providerId: string;
	model: string;
}

export interface ResolvedExecution {
	modelRef: string;
	tab: number | null;
	conversationId: string | null;
	providerId: string | null;
	model: string | null;
}

export interface BackendHost {
	app: App;
	settings: AISettings;
}

export interface ClaudianTabBarItem {
	id: string;
	isWorking?: boolean;
	isStreaming?: boolean;
}

export interface ClaudianModelOption {
	value: string;
	label?: string;
}

export interface ClaudianTab {
	id: string;
	conversationId?: string;
	isStreaming?: boolean;
	error?: unknown;
	state?: {
		isStreaming?: boolean;
		error?: unknown;
		lastError?: unknown;
		messages?: unknown[];
	};
	controllers?: {
		inputController?: {
			sendMessage?: (payload: {
				content: string;
				turnRequestOverride?: Record<string, unknown>;
			}) => Promise<unknown>;
			cancelStreaming?: () => void;
		};
	};
	ui?: {
		modelSelector?: {
			getAvailableModels?: () => ClaudianModelOption[];
		};
	};
}

export interface ClaudianTabManager {
	getAllTabs?: () => ClaudianTab[];
	getTabBarItems?: () => ClaudianTabBarItem[];
	getTab?: (id: string) => ClaudianTab | null;
	getActiveTab?: () => ClaudianTab | null;
	getActiveTabId?: () => string;
	activeTabId?: string;
	isTabWorking?: (id: string) => boolean;
	openConversation?: (id: string, options: { preferNewTab: boolean; activate: boolean }) => Promise<void>;
	switchToTab?: (id: string) => Promise<void>;
}

export interface ClaudianView {
	getTabManager?: () => ClaudianTabManager | null;
	tabManager?: ClaudianTabManager | null;
	getActiveTab?: () => ClaudianTab | null;
}

export interface ClaudianConversation {
	id?: string;
	providerId?: string;
	selectedModel?: string;
	messages?: unknown[];
}

export interface ClaudianSettings {
	savedProviderModel?: Record<string, string>;
	lastSelectedChatModel?: {
		providerId?: string;
		model?: string;
	};
	settingsProvider?: string;
	model?: string;
	/** Per-provider setup (Claudian 2.x): which providers are on and which models are visible. */
	providerConfigs?: Record<string, ClaudianProviderConfig>;
}

export interface ClaudianProviderConfig {
	enabled?: boolean;
	/** Model ids shown in Claudian's chat model picker, in order. */
	visibleModels?: string[] | null;
	selectedModels?: Array<{ label?: string; rawId?: string; encodedId?: string; id?: string }>;
	modelAliases?: Record<string, string>;
}

/** Claudian prefixes some providers' model ids in conversations (e.g. "opencode:<id>"). */
const CLAUDIAN_MODEL_PREFIX: Record<string, string> = { opencode: 'opencode:' };

/**
 * The models Claudian itself offers: the visible models of every enabled
 * provider. Returns null for older Claudian versions without provider configs.
 */
export function configuredClaudianModels(settings: ClaudianSettings | undefined): ModelOption[] | null {
	const configs = settings?.providerConfigs;
	if (!configs || typeof configs !== 'object') return null;
	const options: ModelOption[] = [];
	for (const [providerId, config] of Object.entries(configs)) {
		if (!config || config.enabled === false) continue;
		const selected = Array.isArray(config.selectedModels) ? config.selectedModels : [];
		const ids = Array.isArray(config.visibleModels) && config.visibleModels.length
			? config.visibleModels
			: selected.map(model => model.encodedId || model.rawId || model.id || '');
		for (const rawId of ids) {
			if (typeof rawId !== 'string' || !rawId.trim()) continue;
			const prefix = CLAUDIAN_MODEL_PREFIX[providerId] ?? '';
			const model = prefix && !rawId.startsWith(prefix) ? `${prefix}${rawId}` : rawId;
			const details = selected.find(entry => [entry.encodedId, entry.rawId, entry.id].includes(rawId));
			const label = config.modelAliases?.[rawId]?.trim() || details?.label || rawId;
			options.push({ value: modelValue(providerId, model), label: `${getProviderName(providerId)} / ${label}`, providerId, model });
		}
	}
	return options;
}

export interface ClaudianPlugin {
	getAllViews?: () => ClaudianView[];
	activateView?: () => Promise<void>;
	getConversationSync?: (id: string) => ClaudianConversation | null;
	createConversation?: (options: { providerId: string; selectedModel?: string }) => Promise<ClaudianConversation>;
	renameConversation?: (id: string, name: string) => Promise<void>;
	settings?: ClaudianSettings;
	providerHost?: {
		settings?: ClaudianSettings;
	};
}

export interface CopilotChatManager {
	sendMessage?: (
		prompt: string,
		context: {
			notes: unknown[];
			urls: unknown[];
			folders: string[];
			selectedTextContexts: unknown[];
			webTabs: unknown[];
		},
		chainName?: string,
		flag1?: boolean,
		flag2?: boolean,
	) => Promise<string | number>;
	getLLMMessage?: (messageId: string | number) => unknown;
}

export interface CopilotChainManager {
	runChain?: (
		llmMessage: unknown,
		abortController: AbortController,
		callback1: (message: unknown) => void,
		callback2: (message: unknown) => void,
		options: { debug: boolean },
	) => Promise<unknown>;
}

export interface CopilotPlugin {
	chatManager?: CopilotChatManager;
	chainOwner?: {
		getCurrentChainManager?: () => CopilotChainManager | null;
	};
}

function pluginRegistry(host: BackendHost): Record<string, unknown> | null {
	const app = host.app as unknown as { plugins?: { plugins?: Record<string, unknown> } };
	const registry = app.plugins?.plugins;
	return registry || null;
}

export function getClaudianPlugin(host: BackendHost): ClaudianPlugin | null {
	const plugins = pluginRegistry(host);
	if (!plugins) return null;
	// Claudian's published Obsidian id is realclaudian. Keep the old id as a
	// fallback for development builds and older installations.
	const candidate = plugins.realclaudian ?? plugins.claudian;
	return (candidate as ClaudianPlugin) ?? null;
}

export async function getClaudianView(host: BackendHost): Promise<ClaudianView | null> {
	const claudian = getClaudianPlugin(host);
	if (!claudian) return null;
	let views: ClaudianView[] = typeof claudian.getAllViews === 'function' ? claudian.getAllViews() : [];
	if (!views.length && typeof claudian.activateView === 'function') {
		try { await claudian.activateView(); } catch { /* Claudian may already be opening */ }
		await sleep(1200);
	}
	for (let attempt = 0; attempt < 6; attempt++) {
		views = typeof claudian.getAllViews === 'function' ? claudian.getAllViews() : [];
		if (views[0] && getTabManager(views[0])) return views[0];
		await sleep(500);
	}
	return views[0] || null;
}

export function getTabManager(view: ClaudianView | null): ClaudianTabManager | null {
	if (!view) return null;
	return typeof view.getTabManager === 'function' ? view.getTabManager() : view.tabManager || null;
}

export function getActiveTab(view: ClaudianView | null, manager: ClaudianTabManager | null): ClaudianTab | null {
	if (view && typeof view.getActiveTab === 'function') return view.getActiveTab();
	if (manager && typeof manager.getActiveTab === 'function') return manager.getActiveTab();
	return null;
}

export function getTab(host: BackendHost, view: ClaudianView | null, number: number): ClaudianTab | null {
	const manager = getTabManager(view);
	if (!manager) return null;
	const tabs = typeof manager.getAllTabs === 'function' ? manager.getAllTabs() : [];
	if (tabs.length) return tabs[Math.max(0, Number(number || 1) - 1)] || null;
	const items = typeof manager.getTabBarItems === 'function' ? manager.getTabBarItems() : [];
	const item = items[Math.max(0, Number(number || 1) - 1)];
	return item && typeof manager.getTab === 'function' ? manager.getTab(item.id) : null;
}

export function tabIsBusy(view: ClaudianView | null, tab: ClaudianTab | null): boolean {
	if (!tab) return false;
	const manager = getTabManager(view);
	const items = manager && typeof manager.getTabBarItems === 'function' ? manager.getTabBarItems() : [];
	const item = items.find(candidate => candidate.id === tab.id);
	const working = manager && typeof manager.isTabWorking === 'function' ? manager.isTabWorking(tab.id) : false;
	return Boolean(working || tab.state?.isStreaming || tab.isStreaming || item?.isWorking || item?.isStreaming);
}

export async function waitForTabIdle(view: ClaudianView | null, tab: ClaudianTab | null, signal?: AbortSignal): Promise<void> {
	const started = Date.now();
	while (tabIsBusy(view, tab)) {
		if (signal?.aborted) throw new Error('Cancelled by user.');
		if (tab?.state?.error) {
			throw new Error(`Claudian reported an error: ${errorText(tab.state.error)}`);
		}
		if (Date.now() - started > AGENT_TIMEOUT_MS) {
			throw new Error(`AI task timed out after ${Math.round(AGENT_TIMEOUT_MS / 60000)} minutes. The AI backend did not finish or may be waiting for tool execution/confirmation in Claudian.`);
		}
		await sleep(1000);
	}
	if (tab?.state?.error) {
		throw new Error(`Claudian reported an error: ${errorText(tab.state.error)}`);
	}
}

export function getTabMessages(host: BackendHost, view: ClaudianView | null, tab: ClaudianTab | null): unknown[] {
	const direct = tab?.state?.messages;
	if (Array.isArray(direct) && direct.length) return direct;
	const conversationId = tab?.conversationId;
	const claudian = getClaudianPlugin(host);
	const conversation = conversationId && claudian && typeof claudian.getConversationSync === 'function'
		? claudian.getConversationSync(conversationId) : null;
	return Array.isArray(conversation?.messages) ? conversation.messages : [];
}

export function lastAssistantReply(host: BackendHost, view: ClaudianView | null, tab: ClaudianTab | null, beforeCount: number): string {
	const messages = getTabMessages(host, view, tab);
	const isAssistant = (message: unknown): boolean => {
		if (message && typeof message === 'object' && 'role' in message) {
			return (message as { role?: unknown }).role === 'assistant';
		}
		return false;
	};
	const candidates = messages.slice(Math.max(0, beforeCount)).filter(isAssistant);
	const fallback = messages.filter(isAssistant);
	const messagesToUse = candidates.length ? candidates : fallback;
	const message = messagesToUse[messagesToUse.length - 1];
	return contentFromMessage(message).trim();
}

export async function sendToClaudian(
	host: BackendHost,
	prompt: string,
	tabNumber = host.settings.assistantTab,
	conversationId: string | null = null,
	context: JobContext | null = null,
	signal?: AbortSignal,
): Promise<string> {
	const view = await getClaudianView(host);
	const manager = getTabManager(view);
	if (!view || !manager) throw new Error('Claudian is installed but its chat view is not ready. Open the Claudian view once, then try again.');
	if (conversationId && typeof manager.openConversation === 'function') {
		await manager.openConversation(conversationId, { preferNewTab: false, activate: true });
		await sleep(300);
	}
	const target = conversationId ? getActiveTab(view, manager) : getTab(host, view, tabNumber);
	if (!target) throw new Error(`Claudian chat ${tabNumber} does not exist.`);
	await waitForTabIdle(view, target);
	const activeId = typeof manager.getActiveTabId === 'function' ? manager.getActiveTabId() : manager.activeTabId;
	if (activeId !== target.id && typeof manager.switchToTab === 'function') {
		await manager.switchToTab(target.id);
		await sleep(300);
	}
	const active = getActiveTab(view, manager) || target;
	const controller = active?.controllers?.inputController;
	if (!controller || typeof controller.sendMessage !== 'function') throw new Error('Claudian input controller is unavailable.');

	const turnRequest: Record<string, unknown> = { text: prompt };
	if (context && context.linkedContentPath) turnRequest.linkedContentPath = context.linkedContentPath;
	if (context && context.externalContextPaths && context.externalContextPaths.length) {
		turnRequest.externalContextPaths = context.externalContextPaths;
	}
	// Stop Claudian's stream on timeout or when the user resets the run, instead
	// of leaving the agent working unseen.
	const cancel = () => {
		try { controller.cancelStreaming?.(); } catch { /* best effort */ }
	};

	// Claudian can refuse a send while a freshly opened conversation is still
	// being set up: it shows "Message was not sent" and adds nothing to the
	// conversation. A refused send never reached the AI, so it is safe to retry.
	for (let attempt = 1; ; attempt++) {
		if (signal?.aborted) throw new Error('Cancelled by user.');
		const beforeCount = getTabMessages(host, view, active).length;
		signal?.addEventListener('abort', cancel, { once: true });
		try {
			const send = controller.sendMessage({ content: prompt, turnRequestOverride: turnRequest });
			await withTimeout(send, AGENT_TIMEOUT_MS, `AI task timed out after ${Math.round(AGENT_TIMEOUT_MS / 60000)} minutes`);
			await waitForTabIdle(view, active, signal);
		} catch (error) {
			cancel();
			throw error;
		} finally {
			signal?.removeEventListener('abort', cancel);
		}
		await sleep(300);
		if (getTabMessages(host, view, active).length > beforeCount) {
			const reply = lastAssistantReply(host, view, active, beforeCount);
			// Pass Claudian's own error on instead of treating it as the AI's answer.
			const backendError = claudianErrorFromReply(reply);
			if (backendError) throw new Error(`Claudian reported an error: ${backendError}`);
			return reply;
		}
		if (attempt >= CLAUDIAN_SEND_ATTEMPTS) {
			throw new Error('Claudian refused to send the message ("Message was not sent"), even after retrying. This usually means Claudian could not start the selected model or provider: try sending a message to that model in Claudian directly to see its error, or choose another model in AI Scheduler settings.');
		}
		await sleep(1500 * attempt);
	}
}

/** Sends Claudian refused (see sendToClaudian) are retried up to this many attempts in total. */
const CLAUDIAN_SEND_ATTEMPTS = 3;

/**
 * Claudian reports provider/model failures inside the assistant message, as a
 * line starting with "❌ **Error:**" (or a reply that is just "**Error:** …").
 * Returns that error text, or null when the reply is a normal answer.
 */
export function claudianErrorFromReply(reply: string): string | null {
	const match = /❌\s*\*\*Error:\*\*\s*([^\n]+)/.exec(reply) ?? /^\s*\*\*Error:\*\*\s*([^\n]+)/.exec(reply);
	return match ? match[1].trim() : null;
}

export function getCopilotPlugin(host: BackendHost): CopilotPlugin | null {
	const plugins = pluginRegistry(host);
	if (!plugins) return null;
	const candidate = plugins.copilot ?? plugins['obsidian-copilot'];
	return (candidate as CopilotPlugin) ?? null;
}

export async function sendToCopilot(host: BackendHost, prompt: string, context: JobContext | null = null, signal?: AbortSignal): Promise<string> {
	const copilot = getCopilotPlugin(host);
	const chatManager = copilot?.chatManager;
	const chain = copilot?.chainOwner && typeof copilot.chainOwner.getCurrentChainManager === 'function'
		? copilot.chainOwner.getCurrentChainManager() : null;
	if (!copilot) throw new Error('Obsidian Copilot is not installed or enabled. Install or enable Copilot, then try again.');
	if (!chatManager || typeof chatManager.sendMessage !== 'function' || typeof chatManager.getLLMMessage !== 'function' || !chain || typeof chain.runChain !== 'function') {
		throw new Error('Obsidian Copilot is installed, but its automation API is unavailable. Update Copilot and try again.');
	}
	const paths = context && Array.isArray(context.paths) ? context.paths : [];
	const notes = paths
		.map(path => host.app.vault.getAbstractFileByPath(path))
		.filter((file): file is TFile => file instanceof TFile);
	const folders = paths
		.map(path => host.app.vault.getAbstractFileByPath(path))
		.filter((file): file is TFolder => file instanceof TFolder)
		.map(folder => folder.path);
	const messageId = await chatManager.sendMessage(
		prompt,
		{ notes, urls: [], folders, selectedTextContexts: [], webTabs: [] },
		'llm_chain',
		false,
		false,
	);
	const llmMessage = chatManager.getLLMMessage(messageId);
	if (!llmMessage) throw new Error('Obsidian Copilot did not prepare the scheduler message.');
	let reply = '';
	const abort = new AbortController();
	if (signal?.aborted) throw new Error('Cancelled by user.');
	signal?.addEventListener('abort', () => abort.abort(), { once: true });
	const run = chain.runChain(
		llmMessage,
		abort,
		(message: unknown) => { reply = typeof message === 'string' ? message : contentFromMessage(message) || reply; },
		(message: unknown) => { reply = contentFromMessage(message) || reply; },
		{ debug: false },
	);
	try {
		await withTimeout(run, AGENT_TIMEOUT_MS, `AI task timed out after ${Math.round(AGENT_TIMEOUT_MS / 60000)} minutes`);
	} catch (error) {
		abort.abort(); // stop the chain instead of letting it keep running unseen
		const message = errorText(error);
		// Our own timeout/cancel messages stay as they are; anything else came from Copilot.
		throw /timed out|Cancelled by user/.test(message) ? error : new Error(`Obsidian Copilot reported an error: ${message}`);
	}
	return (reply || '').trim();
}

/* Scheduled runs, the planner and manual reviews can overlap. They share the
 * backend's chat tab, and replies are read back as "the last assistant
 * message", so sends are serialized: each waits for the previous one. */
let backendQueue: Promise<unknown> = Promise.resolve();

export function sendToAI(
	host: BackendHost,
	prompt: string,
	execution: Partial<ResolvedExecution> = {},
	context: JobContext | null = null,
	signal?: AbortSignal,
): Promise<string> {
	const send = () => {
		// Cancelled while waiting in the queue: don't start it at all.
		if (signal?.aborted) return Promise.reject(new Error('Cancelled by user.'));
		return host.settings.backendMode === 'copilot'
			? sendToCopilot(host, prompt, context, signal)
			: sendToClaudian(host, prompt, execution.tab as number | undefined, execution.conversationId || null, context, signal);
	};
	const result = backendQueue.then(send, send);
	backendQueue = result.catch(() => undefined);
	return result;
}

export function getProviderName(providerId: string | null | undefined): string {
	const names: Record<string, string> = {
		claude: 'Claude',
		codex: 'Codex',
		grok: 'Grok',
		opencode: 'OpenCode',
		pi: 'Pi',
		acp: 'ACP',
	};
	if (providerId && providerId in names) {
		return names[providerId];
	}
	return providerId || 'Claudian';
}

export function modelValue(providerId: string, model: string | null | undefined): string {
	return `profile:${encodeURIComponent(JSON.stringify({ providerId, model: model || '' }))}`;
}

export function parseProfileValue(value: string | null | undefined): { providerId: string; model?: string } | null {
	if (!String(value || '').startsWith('profile:')) return null;
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(String(value).slice(8)));
		if (parsed && typeof parsed === 'object' && 'providerId' in parsed) {
			const record = parsed as { providerId: unknown; model?: unknown };
			if (typeof record.providerId === 'string') {
				return {
					providerId: record.providerId,
					model: typeof record.model === 'string' ? record.model : undefined,
				};
			}
		}
		return null;
	} catch {
		return null;
	}
}

export function getClaudianViewSync(host: BackendHost): ClaudianView | null {
	const claudian = getClaudianPlugin(host);
	return claudian && typeof claudian.getAllViews === 'function' ? claudian.getAllViews()[0] || null : null;
}

export function getModelOptions(host: BackendHost): ModelOption[] {
	const profiles: ModelOption[] = [];
	const seen = new Set<string>();
	const add = (profile: ModelOption) => {
		if (!profile || !profile.providerId) return;
		const key = `${profile.providerId}\n${profile.model || ''}`;
		if (seen.has(key)) return;
		seen.add(key);
		profiles.push(profile);
	};
	const claudian = getClaudianPlugin(host);
	// Claudian's own model setup is the source of truth: exactly the models it
	// offers, so removed models disappear and newly added ones show up.
	const configured = configuredClaudianModels(claudian?.settings || claudian?.providerHost?.settings);
	// (An empty list can mean a provider relying on built-in defaults: fall back then.)
	if (configured && configured.length) return configured;

	// Older Claudian versions: infer models from open tabs and remembered choices.
	const view = getClaudianViewSync(host);
	const manager = getTabManager(view);
	const tabs = manager && typeof manager.getAllTabs === 'function' ? manager.getAllTabs() : [];
	tabs.forEach(tab => {
		const conversation = tab.conversationId && claudian && typeof claudian.getConversationSync === 'function'
			? claudian.getConversationSync(tab.conversationId) : null;
		const providerId = conversation?.providerId;
		if (providerId && conversation?.selectedModel) add({
			value: modelValue(providerId, conversation.selectedModel),
			label: `${getProviderName(providerId)} / ${conversation.selectedModel}`,
			providerId,
			model: conversation.selectedModel,
		});
		const modelSelector = tab.ui?.modelSelector;
		if (providerId && modelSelector && typeof modelSelector.getAvailableModels === 'function') {
			try {
				modelSelector.getAvailableModels().forEach(option => add({
					value: modelValue(providerId, option.value),
					label: `${getProviderName(providerId)} / ${option.label || option.value}`,
					providerId,
					model: option.value,
				}));
			} catch { /* Claudian may be rendering the selector */ }
		}
	});
	const settings = claudian?.settings || claudian?.providerHost?.settings;
	const savedModels = settings?.savedProviderModel || {};
	const last = settings?.lastSelectedChatModel;
	if (last && last.providerId) add({
		value: modelValue(last.providerId, last.model),
		label: `${getProviderName(last.providerId)} / ${last.model || 'default model'}`,
		providerId: last.providerId,
		model: last.model || '',
	});
	Object.entries(savedModels).forEach(([providerId, model]) => add({
		value: modelValue(providerId, model),
		label: `${getProviderName(providerId)} / ${model || 'default model'}`,
		providerId,
		model: model || '',
	}));
	const settingsProvider = settings?.settingsProvider;
	const settingsModel = settingsProvider ? (savedModels[settingsProvider] || settings?.model) : undefined;
	if (settingsProvider) add({
		value: modelValue(settingsProvider, settingsModel),
		label: `${getProviderName(settingsProvider)} / ${settingsModel || 'current model'}`,
		providerId: settingsProvider,
		model: settingsModel || '',
	});
	return profiles;
}

export async function refreshModels(host: BackendHost): Promise<ModelOption[]> {
	const view = await getClaudianView(host);
	if (!view || !getTabManager(view)) {
		throw new Error('Claudian is not ready. Open Claudian once, then refresh the model list.');
	}
	return getModelOptions(host);
}

export function checkCopilotSetup(host: BackendHost): { ok: boolean; needsInstall: boolean; message: string; githubUrl: string } {
	const info = BACKEND_INFO.copilot;
	const copilot = getCopilotPlugin(host);
	if (!copilot) return { ok: false, needsInstall: true, message: `${info.name} is not installed or enabled.`, githubUrl: info.githubUrl };
	let chain: CopilotChainManager | null = null;
	try {
		chain = copilot.chainOwner && typeof copilot.chainOwner.getCurrentChainManager === 'function'
			? copilot.chainOwner.getCurrentChainManager()
			: null;
	} catch {
		chain = null;
	}
	if (!copilot.chatManager || typeof copilot.chatManager.sendMessage !== 'function' || typeof copilot.chatManager.getLLMMessage !== 'function'
		|| !chain || typeof chain.runChain !== 'function') {
		return { ok: false, needsInstall: false, message: `${info.name} is installed, but its automation API is unavailable. Update Copilot.`, githubUrl: info.githubUrl };
	}
	return { ok: true, needsInstall: false, message: `${info.name} is ready. Its active Copilot model will be used.`, githubUrl: info.githubUrl };
}

export async function checkClaudianSetup(host: BackendHost): Promise<{ ok: boolean; needsInstall: boolean; message: string; githubUrl: string }> {
	const info = BACKEND_INFO.claudian;
	const claudian = getClaudianPlugin(host);
	if (!claudian) return { ok: false, needsInstall: true, message: `${info.name} is not installed or enabled.`, githubUrl: info.githubUrl };
	const view = await getClaudianView(host);
	const manager = getTabManager(view);
	if (!view || !manager) return { ok: false, needsInstall: false, message: `${info.name} is installed, but its chat runtime is not ready. Open Claudian once and try again.`, githubUrl: info.githubUrl };
	const models = getModelOptions(host);
	if (!models.some(model => model.providerId)) return { ok: false, needsInstall: false, message: `${info.name} is open, but no provider/model is configured.`, githubUrl: info.githubUrl };
	return { ok: true, needsInstall: false, message: `${info.name} is ready with ${models.length} available model option${models.length === 1 ? '' : 's'}.`, githubUrl: info.githubUrl };
}

export function checkBackendSetup(host: BackendHost, mode = host.settings.backendMode): Promise<{ ok: boolean; needsInstall: boolean; message: string; githubUrl: string }> | { ok: boolean; needsInstall: boolean; message: string; githubUrl: string } {
	if (mode === 'none' || !mode) {
		return { ok: false, needsInstall: false, message: 'Please select an AI backend in AI Scheduler settings.', githubUrl: '' };
	}
	return mode === 'copilot' ? checkCopilotSetup(host) : checkClaudianSetup(host);
}

export async function resolveModel(host: BackendHost, value: string | null | undefined, action = 'this action'): Promise<ResolvedExecution> {
	if (host.settings.backendMode === 'none' || !host.settings.backendMode) {
		throw new Error(`No AI backend selected for ${action}. Choose Claudian or Obsidian Copilot in AI Scheduler settings.`);
	}
	if (host.settings.backendMode === 'copilot') {
		const setup = checkCopilotSetup(host);
		if (!setup.ok) {
			const installHint = setup.needsInstall ? ` Install it from ${setup.githubUrl}.` : '';
			throw new Error(`${setup.message}${installHint} It is the active AI Scheduler backend for ${action}.`);
		}
		return { modelRef: 'copilot', tab: null, conversationId: null, providerId: 'copilot', model: null };
	}
	const selected = (typeof value === 'string' && value.trim()) ? value.trim() : (host.settings.executionModel || '').trim();
	if (!selected) {
		throw new Error(`No model selected for ${action}. Choose a model in AI Scheduler settings first.`);
	}
	if (!getClaudianPlugin(host)) {
		const info = BACKEND_INFO.claudian;
		throw new Error(`${info.name} is not installed or enabled. Install it from ${info.githubUrl}. It is required for ${action}.`);
	}
	const availableModels = getModelOptions(host);
	if (!availableModels.some(model => model.value === selected)) {
		throw new Error(`The selected model for ${action} is no longer available in Claudian. Refresh the model list and choose another model.`);
	}
	const profile = parseProfileValue(selected);
	if (!profile || !profile.providerId) {
		throw new Error(`The selected model configuration for ${action} is invalid.`);
	}
	const claudian = getClaudianPlugin(host);
	if (!claudian) throw new Error(`Claudian is not installed or enabled. It is required for ${action}.`);
	if (typeof claudian.createConversation !== 'function') throw new Error(`Claudian cannot create a conversation for ${action}.`);
	let conversation: ClaudianConversation;
	try {
		conversation = await claudian.createConversation({
			providerId: profile.providerId,
			...(profile.model ? { selectedModel: profile.model } : {}),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Claudian could not create the selected model for ${action}: ${message}`);
	}
	if (!conversation || !conversation.id) throw new Error(`Claudian returned no conversation for ${action}.`);
	if (conversation.id && typeof claudian.renameConversation === 'function') {
		// Cosmetic only: a failed rename must not fail the run.
		try {
			await claudian.renameConversation(conversation.id, `AI Scheduler - ${action.charAt(0).toUpperCase()}${action.slice(1)}`);
		} catch (error) {
			console.warn('[ai-scheduler] Could not rename Claudian conversation:', errorText(error));
		}
	}
	return { modelRef: selected, tab: host.settings.assistantTab, conversationId: conversation.id, providerId: profile.providerId, model: profile.model || null };
}

export async function resolveJobExecution(host: BackendHost, job: Job): Promise<ResolvedExecution> {
	const isReview = isPeriodicReviewJob(job);
	const selectedModel = isReview ? host.settings.nightlyReviewModel : host.settings.executionModel;
	const action = isReview ? 'periodic review' : 'scheduled task execution';
	return resolveModel(host, selectedModel, action);
}
