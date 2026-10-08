/*
 * AI backend status shown at the top of the scheduler windows. AI Scheduler
 * does not talk to AI providers itself: Claudian or Obsidian Copilot must be
 * installed, enabled, and set up (providers, keys, models) in their own
 * settings. This bar always offers a one-click way to the right place.
 */
import { App } from 'obsidian';
import type { AISchedulerPlugin } from '../main';
import { BACKEND_INFO } from '../types';

type BackendKey = keyof typeof BACKEND_INFO;
type InstallState = 'enabled' | 'disabled' | 'missing';

/** Plugin ids each backend has been published under (current id first). */
const PLUGIN_IDS: Record<BackendKey, string[]> = {
	claudian: ['realclaudian', 'claudian'],
	copilot: ['copilot', 'obsidian-copilot'],
};

interface PluginRegistry {
	plugins?: Record<string, unknown>;
	manifests?: Record<string, unknown>;
}

/** Whether a backend plugin is enabled, installed but turned off, or not installed. */
export function backendInstallState(app: App, key: BackendKey): InstallState {
	const registry = (app as unknown as { plugins?: PluginRegistry }).plugins;
	const ids = PLUGIN_IDS[key];
	if (ids.some(id => registry?.plugins?.[id])) return 'enabled';
	if (ids.some(id => registry?.manifests?.[id])) return 'disabled';
	return 'missing';
}

function installedId(app: App, key: BackendKey): string {
	const registry = (app as unknown as { plugins?: PluginRegistry }).plugins;
	return PLUGIN_IDS[key].find(id => registry?.plugins?.[id] || registry?.manifests?.[id]) ?? PLUGIN_IDS[key][0];
}

/**
 * Renders the backend bar. `leave` closes the current window before jumping to
 * settings or the plugin store, so the settings dialog isn't hidden behind it.
 */
export function renderBackendBar(container: HTMLElement, plugin: AISchedulerPlugin, leave: (then: () => void) => void): void {
	const app = plugin.app;
	const readiness = plugin.getBackendReadiness();
	const mode = plugin.settings.backendMode;
	const selected: BackendKey | null = mode === 'claudian' || mode === 'copilot' ? mode : null;
	const bar = container.createDiv({ cls: `ai-scheduler-backend-bar ${readiness.ok ? 'is-ready' : 'is-warning'}` });

	const text = bar.createDiv({ cls: 'ai-scheduler-backend-bar-text' });
	const actions = bar.createDiv({ cls: 'ai-scheduler-backend-bar-actions' });
	const button = (label: string, onClick: () => void, primary = false) => {
		const el = actions.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
		el.addEventListener('click', () => leave(onClick));
	};
	const openStore = (key: BackendKey) => window.open(`obsidian://show-plugin?id=${PLUGIN_IDS[key][0]}`);

	if (selected && backendInstallState(app, selected) === 'enabled') {
		const name = BACKEND_INFO[selected].name;
		text.createDiv({ cls: 'ai-scheduler-backend-bar-title', text: readiness.ok ? `AI backend: ${name}` : `${name} needs setup` });
		text.createDiv({
			cls: 'ai-scheduler-backend-bar-desc',
			text: readiness.ok
				? `Providers, API keys and models are managed in ${name}'s settings; AI Scheduler uses what is set there.`
				: `${readiness.message} Set up providers and models in ${name}'s settings; AI Scheduler uses what is set there.`,
		});
		// Always offered, ready or not: this is where models and keys live.
		button(`Open ${name} settings`, () => plugin.openSettingsTab(installedId(app, selected)), !readiness.ok);
		if (!readiness.ok) button('AI Scheduler settings', () => plugin.openSettingsTab());
		return;
	}

	// Nothing usable selected: explain the requirement and offer each backend.
	text.createDiv({ cls: 'ai-scheduler-backend-bar-title', text: 'Connect an AI backend to get started' });
	text.createDiv({
		cls: 'ai-scheduler-backend-bar-desc',
		text: selected
			? `${BACKEND_INFO[selected].name} is selected but not ${backendInstallState(app, selected) === 'disabled' ? 'enabled' : 'installed'}. AI Scheduler runs your tasks through Claudian or Obsidian Copilot: install and enable one, set up its providers and models in its own settings, then choose it in AI Scheduler settings.`
			: 'AI Scheduler runs your tasks through Claudian or Obsidian Copilot. Install and enable one, set up its providers and models in its own settings, then choose it in AI Scheduler settings.',
	});
	for (const key of Object.keys(BACKEND_INFO) as BackendKey[]) {
		const name = BACKEND_INFO[key].name;
		const state = backendInstallState(app, key);
		if (state === 'enabled') button(`Open ${name} settings`, () => plugin.openSettingsTab(installedId(app, key)));
		else if (state === 'disabled') button(`Enable ${name}`, () => plugin.openSettingsTab('community-plugins'));
		else button(`Install ${name}`, () => openStore(key));
	}
	button('AI Scheduler settings', () => plugin.openSettingsTab(), true);
}
