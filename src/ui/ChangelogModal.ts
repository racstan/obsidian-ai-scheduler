/*
 * Interactive Changelog & What's New Modal
 */
import { App, Modal, Setting } from 'obsidian';
import type { AISchedulerPlugin } from '../main';
import { CHANGELOG_DATA, getLatestRelease, getReleasesSince, ReleaseChangelog } from '../changelog';
import { closeExistingSchedulerModals } from './dom';

export interface ChangelogModalOptions {
	fromVersion?: string | null;
	currentVersion?: string;
	isAutomatic?: boolean;
}

export class ChangelogModal extends Modal {
	private plugin: AISchedulerPlugin;
	private options: ChangelogModalOptions;
	private viewMode: 'recent' | 'all' = 'recent';

	constructor(app: App, plugin: AISchedulerPlugin, options: ChangelogModalOptions = {}) {
		super(app);
		this.plugin = plugin;
		this.options = options;
	}

	onOpen(): void {
		closeExistingSchedulerModals(this);
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-md');
		this.modalEl.addClass('ai-scheduler-changelog-window');
		contentEl.empty();
		contentEl.addClass('ai-scheduler-changelog-modal');

		const currentVersion = this.options.currentVersion || this.plugin.manifest.version;
		const fromVersion = this.options.fromVersion;

		// Header Section
		const headerEl = contentEl.createDiv({ cls: 'ai-scheduler-changelog-header' });
		const titleEl = headerEl.createEl('h2', { text: '✨ What\'s new in AI Scheduler' });
		titleEl.addClass('ai-scheduler-changelog-title');

		const subtext = fromVersion && fromVersion !== currentVersion
			? `Updated from v${fromVersion} → v${currentVersion}`
			: `Version v${currentVersion}`;
		headerEl.createEl('p', { text: subtext, cls: 'ai-scheduler-changelog-subtitle' });

		// Tab Controls / View Switcher
		const tabRow = contentEl.createDiv({ cls: 'ai-scheduler-changelog-tabs' });
		const recentBtn = tabRow.createEl('button', {
			text: fromVersion && fromVersion !== currentVersion ? 'Changes in this update' : `v${currentVersion} highlights`,
			cls: `ai-scheduler-tab-btn ${this.viewMode === 'recent' ? 'is-active' : ''}`,
		});
		const allBtn = tabRow.createEl('button', {
			text: 'Full version history',
			cls: `ai-scheduler-tab-btn ${this.viewMode === 'all' ? 'is-active' : ''}`,
		});

		const listContainer = contentEl.createDiv({ cls: 'ai-scheduler-changelog-content' });

		const renderList = () => {
			listContainer.empty();
			recentBtn.toggleClass('is-active', this.viewMode === 'recent');
			allBtn.toggleClass('is-active', this.viewMode === 'all');

			const releases: ReleaseChangelog[] = this.viewMode === 'recent'
				? getReleasesSince(fromVersion)
				: CHANGELOG_DATA;

			for (const release of releases) {
				this.renderReleaseCard(listContainer, release);
			}
		};

		recentBtn.addEventListener('click', () => {
			this.viewMode = 'recent';
			renderList();
		});

		allBtn.addEventListener('click', () => {
			this.viewMode = 'all';
			renderList();
		});

		renderList();

		// Footer Controls
		const footerEl = contentEl.createDiv({ cls: 'ai-scheduler-changelog-footer' });

		// Setting / Checkbox for "Don't show automatically"
		new Setting(footerEl)
			.setName('Show changelog after future updates')
			.setDesc('Automatically open this dialog when AI Scheduler is updated.')
			.addToggle(toggle => {
				toggle
					.setValue(this.plugin.settings.showChangelogOnUpdate)
					.onChange(async (val: boolean) => {
						this.plugin.settings.showChangelogOnUpdate = val;
						await this.plugin.saveState();
					});
			});

		const actionsRow = footerEl.createDiv({ cls: 'ai-scheduler-changelog-actions' });

		const starBtn = actionsRow.createEl('button', {
			text: '⭐ Star on GitHub',
			cls: 'ai-scheduler-star-btn',
		});
		starBtn.addEventListener('click', () => {
			window.open('https://github.com/racstan/obsidian-ai-scheduler', '_blank');
		});

		const closeBtn = actionsRow.createEl('button', {
			text: 'Got it',
			cls: 'mod-cta ai-scheduler-close-btn',
		});
		closeBtn.addEventListener('click', () => this.close());
	}

	private renderReleaseCard(parent: HTMLElement, release: ReleaseChangelog): void {
		const card = parent.createDiv({ cls: 'ai-scheduler-release-card' });

		// Release Header
		const header = card.createDiv({ cls: 'ai-scheduler-release-header' });
		const titleRow = header.createDiv({ cls: 'ai-scheduler-release-title-row' });
		
		const badge = titleRow.createSpan({ cls: 'ai-scheduler-version-badge', text: `v${release.version}` });
		if (release.version === getLatestRelease().version) {
			badge.addClass('is-latest');
		}
		
		titleRow.createSpan({ cls: 'ai-scheduler-release-name', text: release.title });
		header.createSpan({ cls: 'ai-scheduler-release-date', text: release.date });

		// Highlights
		if (release.highlights && release.highlights.length) {
			const hlBox = card.createDiv({ cls: 'ai-scheduler-release-highlights' });
			hlBox.createDiv({ cls: 'ai-scheduler-changelog-section-heading', text: '✨ Highlights' });
			const ul = hlBox.createEl('ul');
			for (const hl of release.highlights) {
				ul.createEl('li', { text: hl });
			}
		}

		// Added
		if (release.added && release.added.length) {
			const section = card.createDiv({ cls: 'ai-scheduler-release-section' });
			section.createDiv({ cls: 'ai-scheduler-changelog-section-heading added', text: '🟢 Added' });
			const ul = section.createEl('ul');
			for (const item of release.added) {
				ul.createEl('li', { text: item });
			}
		}

		// Changed
		if (release.changed && release.changed.length) {
			const section = card.createDiv({ cls: 'ai-scheduler-release-section' });
			section.createDiv({ cls: 'ai-scheduler-changelog-section-heading changed', text: '🟡 Changed' });
			const ul = section.createEl('ul');
			for (const item of release.changed) {
				ul.createEl('li', { text: item });
			}
		}

		// Fixed
		if (release.fixed && release.fixed.length) {
			const section = card.createDiv({ cls: 'ai-scheduler-release-section' });
			section.createDiv({ cls: 'ai-scheduler-changelog-section-heading fixed', text: '🛠️ Fixed' });
			const ul = section.createEl('ul');
			for (const item of release.fixed) {
				ul.createEl('li', { text: item });
			}
		}

		// Contributors
		if (release.contributors && release.contributors.length) {
			const section = card.createDiv({ cls: 'ai-scheduler-release-section' });
			section.createDiv({ cls: 'ai-scheduler-changelog-section-heading contributors', text: '👥 Contributors' });
			const list = section.createDiv({ cls: 'ai-scheduler-contributors-list' });
			for (const contributor of release.contributors) {
				const chip = list.createEl('a', {
					cls: 'ai-scheduler-contributor-chip',
					href: contributor.url,
				});
				chip.target = '_blank';
				chip.createSpan({ cls: 'ai-scheduler-contributor-name', text: contributor.name });
				if (contributor.username) {
					chip.createSpan({ cls: 'ai-scheduler-contributor-handle', text: ` (@${contributor.username})` });
				}
				if (contributor.role) {
					chip.createSpan({ cls: 'ai-scheduler-contributor-role', text: ` · ${contributor.role}` });
				}
			}
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}
