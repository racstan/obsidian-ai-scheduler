/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions */
/*

 * Backend integration for Claudian and Obsidian Copilot.
 *
 * Both backends are driven through their published plugin internals with
 * duck-typed guards, exactly like the original implementation: this plugin
 * never calls an AI provider and holds no API keys. Functions take the plugin
 * instance so the orchestration stays in main.ts.
 */
import { App, Notice } from 'obsidian';
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

type AnyRecord = Record<string, any>;

function pluginRegistry(host: BackendHost): Record<string, AnyRecord> | null {
	const app = host.app as unknown as { plugins?: { plugins?: Record<string, AnyRecord> } };
	const registry = app.plugins && app.plugins.plugins;
	return registry || null;
}

export function getClaudianPlugin(host: BackendHost): AnyRecord | null {
	const plugins = pluginRegistry(host);
	if (!plugins) return null;
	// Claudian's published Obsidian id is realclaudian. Keep the old id as a
	// fallback for development builds and older installations.
	return plugins.realclaudian || plugins.claudian || null;
}

export async function getClaudianView(host: BackendHost): Promise<AnyRecord | null> {
	const claudian = getClaudianPlugin(host);
	if (!claudian) return null;
	let views = typeof claudian.getAllViews === 'function' ? claudian.getAllViews() : [];
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

export function getTabManager(view: AnyRecord | null): AnyRecord | null {
	if (!view) return null;
	return typeof view.getTabManager === 'function' ? view.getTabManager() : view.tabManager || null;
}

export function getActiveTab(view: AnyRecord | null, manager: AnyRecord | null): AnyRecord | null {
	if (view && typeof view.getActiveTab === 'function') return view.getActiveTab();
	if (manager && typeof manager.getActiveTab === 'function') return manager.getActiveTab();
	return null;
}

export function getTab(host: BackendHost, view: AnyRecord | null, number: number): AnyRecord | null {
	const manager = getTabManager(view);
	if (!manager) return null;
	const tabs = typeof manager.getAllTabs === 'function' ? manager.getAllTabs() : [];
	if (tabs.length) return tabs[Math.max(0, Number(number || 1) - 1)] || null;
	const items = typeof manager.getTabBarItems === 'function' ? manager.getTabBarItems() : [];
	const item = items[Math.max(0, Number(number || 1) - 1)];
	return item && typeof manager.getTab === 'function' ? manager.getTab(item.id) : null;
}

export function tabIsBusy(view: AnyRecord | null, tab: AnyRecord | null): boolean {
	if (!tab) return false;
	const manager = getTabManager(view);
	const item = manager && typeof manager.getTabBarItems === 'function'
		? (manager.getTabBarItems() as AnyRecord[]).find(candidate => candidate.id === tab.id) : null;
	const working = manager && typeof manager.isTabWorking === 'function' ? manager.isTabWorking(tab.id) : false;
	return Boolean(working || tab.state && tab.state.isStreaming || tab.isStreaming || item && (item.isWorking || item.isStreaming));
}

export async function waitForTabIdle(view: AnyRecord | null, tab: AnyRecord | null): Promise<void> {
	const started = Date.now();
	while (tabIsBusy(view, tab)) {
		if (Date.now() - started > AGENT_TIMEOUT_MS) throw new Error('Claudian chat stayed busy for 30 minutes');
		await sleep(1000);
	}
}

export function getTabMessages(host: BackendHost, view: AnyRecord | null, tab: AnyRecord | null): AnyRecord[] {
	const direct = tab && tab.state && Array.isArray(tab.state.messages) ? tab.state.messages : [];
	if (direct.length) return direct;
	const conversationId = tab && tab.conversationId;
	const claudian = getClaudianPlugin(host);
	const conversation = conversationId && claudian && typeof claudian.getConversationSync === 'function'
		? claudian.getConversationSync(conversationId) : null;
	return conversation && Array.isArray(conversation.messages) ? conversation.messages : [];
}

export function lastAssistantReply(host: BackendHost, view: AnyRecord | null, tab: AnyRecord | null, beforeCount: number): string {
	const messages = getTabMessages(host, view, tab);
	const candidates = messages.slice(Math.max(0, beforeCount)).filter(message => message.role === 'assistant');
	const fallback = messages.filter(message => message.role === 'assistant');
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
	const controller = active && active.controllers && active.controllers.inputController;
	if (!controller || typeof controller.sendMessage !== 'function') throw new Error('Claudian input controller is unavailable.');

	const turnRequest: AnyRecord = { text: prompt };
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

export function getCopilotPlugin(host: BackendHost): AnyRecord | null {
	const plugins = pluginRegistry(host);
	if (!plugins) return null;
	return plugins.copilot || plugins['obsidian-copilot'] || null;
}

export async function sendToCopilot(host: BackendHost, prompt: string, context: JobContext | null = null): Promise<string> {
	const copilot = getCopilotPlugin(host);
	const chatManager = copilot && copilot.chatManager;
	const chain = copilot && copilot.chainOwner && typeof copilot.chainOwner.getCurrentChainManager === 'function'
		? copilot.chainOwner.getCurrentChainManager() : null;
	if (!copilot) throw new Error('Obsidian Copilot is not installed or enabled. Install or enable Copilot, then try again.');
	if (!chatManager || typeof chatManager.sendMessage !== 'function' || typeof chatManager.getLLMMessage !== 'function' || !chain || typeof chain.runChain !== 'function') {
		throw new Error('Obsidian Copilot is installed, but its automation API is unavailable. Update Copilot and try again.');
	}
	const paths = context && Array.isArray(context.paths) ? context.paths : [];
	const notes = paths
		.map(path => host.app.vault.getAbstractFileByPath(path))
		.filter(file => file && !Array.isArray((file as AnyRecord).children));
	const folders = paths
		.map(path => host.app.vault.getAbstractFileByPath(path))
		.filter(file => file && Array.isArray((file as AnyRecord).children))
		.map(file => (file as AnyRecord).path);
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
	return String(reply || '').trim();
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
	return names[providerId || ''] || providerId || 'Claudian';
}

export function modelValue(providerId: string, model: string | null | undefined): string {
	return `profile:${encodeURIComponent(JSON.stringify({ providerId, model: model || '' }))}`;
}

export function parseProfileValue(value: string | null | undefined): { providerId: string; model?: string } | null {
	if (!String(value || '').startsWith('profile:')) return null;
	try { return JSON.parse(decodeURIComponent(String(value).slice(8))); } catch { return null; }
}

export function getClaudianViewSync(host: BackendHost): AnyRecord | null {
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
	tabs.forEach((tab: AnyRecord) => {
		const conversation = tab.conversationId && claudian && typeof claudian.getConversationSync === 'function'
			? claudian.getConversationSync(tab.conversationId) : null;
		const providerId = conversation && conversation.providerId;
		if (providerId && conversation.selectedModel) add({
			value: modelValue(providerId, conversation.selectedModel),
			label: `${getProviderName(providerId)} / ${conversation.selectedModel}`,
			providerId,
			model: conversation.selectedModel,
		});
		if (providerId && tab.ui && tab.ui.modelSelector && typeof tab.ui.modelSelector.getAvailableModels === 'function') {
			try {
				tab.ui.modelSelector.getAvailableModels().forEach((option: AnyRecord) => add({
					value: modelValue(providerId, option.value),
					label: `${getProviderName(providerId)} / ${option.label || option.value}`,
					providerId,
					model: option.value,
				}));
			} catch { /* Claudian may be rendering the selector */ }
		}
	});
	const settings = claudian && (claudian.settings || claudian.providerHost && claudian.providerHost.settings) || {};
	const savedModels = settings.savedProviderModel || {};
	const last = settings.lastSelectedChatModel;
	if (last && last.providerId) add({
		value: modelValue(last.providerId, last.model),
		label: `${getProviderName(last.providerId)} / ${last.model || 'default model'}`,
		providerId: last.providerId,
		model: last.model || '',
	});
	Object.entries(savedModels).forEach(([providerId, model]) => add({
		value: modelValue(providerId, model as string),
		label: `${getProviderName(providerId)} / ${model || 'default model'}`,
		providerId,
		model: String(model || ''),
	}));
	const settingsProvider = settings.settingsProvider;
	const settingsModel = settingsProvider && (savedModels[settingsProvider] || settings.model);
	if (settingsProvider) add({
		value: modelValue(settingsProvider, settingsModel),
		label: `${getProviderName(settingsProvider)} / ${settingsModel || 'current model'}`,
		providerId: settingsProvider,
		model: String(settingsModel || ''),
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
	let chain: AnyRecord | null = null;
	try { chain = copilot.chainOwner && typeof copilot.chainOwner.getCurrentChainManager === 'function' ? copilot.chainOwner.getCurrentChainManager() : null; } catch { chain = null; }
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
		const conversation = runtime && runtime.conversationId && claudian && typeof claudian.getConversationSync === 'function'
			? claudian.getConversationSync(runtime.conversationId) : null;
		if (!conversation || !conversation.providerId) throw new Error(`The Claudian chat selected for ${action} has no configured provider.`);
		return { modelRef: selected, tab, conversationId: runtime && runtime.conversationId || null, providerId: conversation && conversation.providerId || null, model: conversation && conversation.selectedModel || null };
	}
	const profile = parseProfileValue(selected);
	if (profile && profile.providerId) {
		const claudian = getClaudianPlugin(host);
		if (!claudian) throw new Error(`Claudian is not installed or enabled. It is required for ${action}.`);
		if (typeof claudian.createConversation !== 'function') throw new Error(`Claudian cannot create a conversation for ${action}.`);
		let conversation: AnyRecord;
		try {
			conversation = await claudian.createConversation({
				providerId: profile.providerId,
				...(profile.model ? { selectedModel: profile.model } : {}),
			});
		} catch (error) {
			throw new Error(`Claudian could not create the selected model for ${action}: ${String((error as Error)?.message || error)}`);
		}
		if (!conversation || !conversation.id) throw new Error(`Claudian returned no conversation for ${action}.`);
		if (conversation && conversation.id && typeof claudian.renameConversation === 'function') {
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
