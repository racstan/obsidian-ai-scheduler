/*
 * Backend integration for Claudian and Obsidian Copilot.
 *
 * Both backends are driven through their published plugin internals with
 * duck-typed guards, exactly like the original implementation: this plugin
 * never calls an AI provider and holds no API keys. Functions take the plugin
 * instance so the orchestration stays in main.ts.
 */
import { App, Notice, TFile, TFolder } from 'obsidian';
import { AISettings, BACKEND_INFO, Job } from './types';
import { contentFromMessage, sleep } from './util';

export const AGENT_TIMEOUT_MS = 30 * 60 * 1000;

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

export interface JobContext {
	paths: string[];
	missingPaths: string[];
	linkedContentPath: string | null;
	externalContextPaths: string[];
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
	state?: {
		isStreaming?: boolean;
		messages?: unknown[];
	};
	controllers?: {
		inputController?: {
			sendMessage?: (payload: {
				content: string;
				turnRequestOverride?: Record<string, unknown>;
			}) => Promise<unknown>;
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

export async function waitForTabIdle(view: ClaudianView | null, tab: ClaudianTab | null): Promise<void> {
	const started = Date.now();
	while (tabIsBusy(view, tab)) {
		if (Date.now() - started > AGENT_TIMEOUT_MS) throw new Error('Claudian chat stayed busy for 30 minutes');
		await sleep(1000);
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
	const beforeCount = getTabMessages(host, view, active).length;
	const controller = active?.controllers?.inputController;
	if (!controller || typeof controller.sendMessage !== 'function') throw new Error('Claudian input controller is unavailable.');

	const turnRequest: Record<string, unknown> = { text: prompt };
	if (context && context.linkedContentPath) turnRequest.linkedContentPath = context.linkedContentPath;
	if (context && context.externalContextPaths && context.externalContextPaths.length) {
		turnRequest.externalContextPaths = context.externalContextPaths;
	}
	const send = controller.sendMessage({ content: prompt, turnRequestOverride: turnRequest });
	await Promise.race([
		send,
		sleep(AGENT_TIMEOUT_MS).then(() => { throw new Error('AI task timed out after 30 minutes'); }),
	]);
	await waitForTabIdle(view, active);
	await sleep(300);
	return lastAssistantReply(host, view, active, beforeCount);
}

export function getCopilotPlugin(host: BackendHost): CopilotPlugin | null {
	const plugins = pluginRegistry(host);
	if (!plugins) return null;
	const candidate = plugins.copilot ?? plugins['obsidian-copilot'];
	return (candidate as CopilotPlugin) ?? null;
}

export async function sendToCopilot(host: BackendHost, prompt: string, context: JobContext | null = null): Promise<string> {
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
	const run = chain.runChain(
		llmMessage,
		new AbortController(),
		(message: unknown) => { reply = typeof message === 'string' ? message : contentFromMessage(message) || reply; },
		(message: unknown) => { reply = contentFromMessage(message) || reply; },
		{ debug: false },
	);
	await Promise.race([
		run,
		sleep(AGENT_TIMEOUT_MS).then(() => { throw new Error('AI task timed out after 30 minutes'); }),
	]);
	return (reply || '').trim();
}

export function sendToAI(
	host: BackendHost,
	prompt: string,
	execution: Partial<ResolvedExecution> = {},
	context: JobContext | null = null,
): Promise<string> {
	return host.settings.backendMode === 'copilot'
		? sendToCopilot(host, prompt, context)
		: sendToClaudian(host, prompt, execution.tab as number | undefined, execution.conversationId || null, context);
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
	const view = getClaudianViewSync(host);
	const manager = getTabManager(view);
	const claudian = getClaudianPlugin(host);
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
	return mode === 'copilot' ? checkCopilotSetup(host) : checkClaudianSetup(host);
}

export async function resolveModel(host: BackendHost, value: string | null | undefined, action = 'this action'): Promise<ResolvedExecution> {
	if (host.settings.backendMode === 'copilot') {
		const setup = checkCopilotSetup(host);
		if (!setup.ok) {
			const installHint = setup.needsInstall ? ` Install it from ${setup.githubUrl}.` : '';
			throw new Error(`${setup.message}${installHint} It is the active AI Scheduler backend for ${action}.`);
		}
		return { modelRef: 'copilot', tab: null, conversationId: null, providerId: 'copilot', model: null };
	}
	const selected = value === undefined || value === null ? host.settings.executionModel : value;
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
	if (String(selected).startsWith('tab:')) {
		const tab = Math.max(1, Number.parseInt(String(selected).slice(4), 10) || 1);
		const view = await getClaudianView(host);
		const runtime = getTab(host, view, tab);
		if (!runtime) throw new Error(`The Claudian chat selected for ${action} no longer exists. Refresh the model list and choose another model.`);
		const claudian = getClaudianPlugin(host);
		const conversation = runtime.conversationId && claudian && typeof claudian.getConversationSync === 'function'
			? claudian.getConversationSync(runtime.conversationId) : null;
		if (!conversation || !conversation.providerId) throw new Error(`The Claudian chat selected for ${action} has no configured provider.`);
		return { modelRef: selected, tab, conversationId: runtime.conversationId || null, providerId: conversation.providerId, model: conversation.selectedModel || null };
	}
	const profile = parseProfileValue(selected);
	if (profile && profile.providerId) {
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
			await claudian.renameConversation(conversation.id, 'AI Scheduler - Planning');
		}
		return { modelRef: selected, tab: host.settings.assistantTab, conversationId: conversation.id, providerId: profile.providerId, model: profile.model || null };
	}
	return { modelRef: '', tab: host.settings.assistantTab, conversationId: null, providerId: null, model: null };
}

export async function resolveJobExecution(host: BackendHost, job: Job): Promise<ResolvedExecution> {
	const selectedModel = job.routine === 'daily-review' ? host.settings.nightlyReviewModel : host.settings.executionModel;
	const action = job.routine === 'daily-review' ? 'nightly review' : 'scheduled task execution';
	return resolveModel(host, selectedModel, action);
}

export function notify(message: string, timeout = 5000): void {
	new Notice(message, timeout);
}
