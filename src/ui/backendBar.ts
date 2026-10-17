/*
 * AI backend status shown at the top of the scheduler windows. AI Scheduler
 * does not talk to AI providers itself: Claudian (or Oh My Claudian) or Obsidian Copilot must be
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
	'oh-my-claudian': ['oh-my-claudian'],
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
 * Renders the backend bar. When the selected backend is ready, that is just a
 * plain "<Backend> settings" button, added to `buttonRow` if given (otherwise
 * in a small row of its own). Otherwise a box explains what is missing and
 * how to fix it. `leave` closes the current window before jumping to settings
 * or the plugin store, so the settings dialog isn't hidden behind it.
 */
export function renderBackendBar(
	container: HTMLElement,
	plugin: AISchedulerPlugin,
	leave: (then: () => void) => void,
	buttonRow?: HTMLElement,
): void {
	const app = plugin.app;
	const readiness = plugin.getBackendReadiness();
	const mode = plugin.settings.backendMode;
	const selected: BackendKey | null = mode === 'none' || !mode ? null : mode;
	if (selected && readiness.ok && backendInstallState(app, selected) === 'enabled') {
		const row = buttonRow ?? container.createDiv({ cls: 'ai-scheduler-backend-link-row' });
		const name = BACKEND_INFO[selected].name;
		const link = row.createEl('button', { text: `${name} settings` });
		link.setAttribute('title', `Providers, API keys and models are managed in ${name}'s settings.`);
		link.addEventListener('click', () => leave(() => plugin.openSettingsTab(installedId(app, selected))));
		return;
	}
	const bar = container.createDiv({ cls: 'ai-scheduler-backend-bar is-warning' });

	const text = bar.createDiv({ cls: 'ai-scheduler-backend-bar-text' });
	const actions = bar.createDiv({ cls: 'ai-scheduler-backend-bar-actions' });
	const button = (label: string, onClick: () => void, primary = false) => {
		const el = actions.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
		el.addEventListener('click', () => leave(onClick));
	};
	const openStore = (key: BackendKey) => window.open(`obsidian://show-plugin?id=${PLUGIN_IDS[key][0]}`);

	if (selected && backendInstallState(app, selected) === 'enabled') {
		const name = BACKEND_INFO[selected].name;
		text.createDiv({ cls: 'ai-scheduler-backend-bar-title', text: `${name} needs setup` });
		text.createDiv({
			cls: 'ai-scheduler-backend-bar-desc',
			text: `${readiness.message} Set up providers and models in ${name}'s settings; AI Scheduler uses what is set there.`,
		});
		button(`Open ${name} settings`, () => plugin.openSettingsTab(installedId(app, selected)), true);
		button('AI Scheduler settings', () => plugin.openSettingsTab());
		return;
	}

	// Nothing usable selected: explain the requirement and offer each backend.
	text.createDiv({ cls: 'ai-scheduler-backend-bar-title', text: 'Connect an AI backend to get started' });
	text.createDiv({
		cls: 'ai-scheduler-backend-bar-desc',
		text: selected
			? `${BACKEND_INFO[selected].name} is selected but not ${backendInstallState(app, selected) === 'disabled' ? 'enabled' : 'installed'}. Install and enable it, set up its providers and models in its own settings, or choose another backend in AI Scheduler settings.`
			: 'AI Scheduler runs your tasks through Claudian, Oh My Claudian or Obsidian Copilot. Install and enable one, set up its providers and models in its own settings, then choose it in AI Scheduler settings.',
	});
	// Offer the selected backend, or (with none selected) the two main ones; Oh My
	// Claudian is a Claudian fork for people who already use it.
	const offered = selected ? [selected] : (['claudian', 'copilot'] as BackendKey[]);
	for (const key of offered) {
		const name = BACKEND_INFO[key].name;
		const state = backendInstallState(app, key);
		if (state === 'enabled') button(`Open ${name} settings`, () => plugin.openSettingsTab(installedId(app, key)));
		else if (state === 'disabled') button(`Enable ${name}`, () => plugin.openSettingsTab('community-plugins'));
		else button(`Install ${name}`, () => openStore(key));
	}
	button('AI Scheduler settings', () => plugin.openSettingsTab(), true);
}
