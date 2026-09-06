import { PluginSettingTab, App, Setting, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { BACKEND_INFO } from '../types';
import { errorText } from '../util';

export class AssistantSettingTab extends PluginSettingTab {
	plugin: AISchedulerPlugin;

	constructor(app: App, plugin: AISchedulerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions() {
		return []; // Return empty array to suppress the missing method warning until fully migrated to declarative settings
	}

	renderBackendStatus(containerEl: HTMLElement): void {
		const info = BACKEND_INFO[this.plugin.settings.backendMode === 'copilot' ? 'copilot' : 'claudian'];
		const setting = new Setting(containerEl)
			.setName('Active backend')
			.setDesc('Checking readiness...');
		const update = (result: { ok: boolean; needsInstall: boolean; message: string; githubUrl?: string }) => {
			setting.setDesc('');
			const desc = setting.descEl;
			desc.empty();
			desc.addClass(result.ok ? 'ai-scheduler-status-ok' : 'ai-scheduler-status-error');
			desc.createSpan({ text: result.message });
			if (!result.ok && result.needsInstall) {
				desc.createSpan({ text: ' ' });
				const link = desc.createEl('a', { text: `Open ${info.name} on GitHub`, href: result.githubUrl || info.githubUrl });
				link.target = '_blank';
			}
		};
		const installed = this.plugin.settings.backendMode === 'copilot'
			? Boolean(this.plugin.getCopilotPlugin())
			: Boolean(this.plugin.getClaudianPlugin());
		if (!installed) {
			update({ ok: false, needsInstall: true, message: `${info.name} is not installed or enabled.`, githubUrl: info.githubUrl });
			return;
		}
		void Promise.resolve(this.plugin.checkBackendSetup()).then(update).catch(error => {
			update({ ok: false, needsInstall: false, message: errorText(error), githubUrl: info.githubUrl });
		});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('p', { text: 'Choose one AI backend. AI Scheduler never runs Claudian and Copilot at the same time.' });
		new Setting(containerEl)
			.setName('AI backend')
			.setDesc('Claudian uses the model choices below. Copilot uses the active model configured in Obsidian Copilot.')
			.addDropdown(dropdown => dropdown
				.addOption('claudian', 'Claudian')
				.addOption('copilot', 'Obsidian Copilot')
				.setValue(this.plugin.settings.backendMode === 'copilot' ? 'copilot' : 'claudian')
				.onChange(value => {
					void (async () => {
						this.plugin.settings.backendMode = value === 'copilot' ? 'copilot' : 'claudian';
						await this.plugin.saveState();
						this.display();
					})();
				}));
		this.renderBackendStatus(containerEl);

		const models = this.plugin.settings.backendMode === 'copilot' ? [] : this.plugin.getModelOptions();
		if (this.plugin.settings.backendMode === 'claudian') {
			new Setting(containerEl)
				.setName('Available Claudian models')
				.setDesc('Refresh this list after adding, removing, or changing models in Claudian.')
				.addButton(button => button.setButtonText('Refresh models').onClick(() => {
					void (async () => {
						button.setDisabled(true);
						try {
							await this.plugin.refreshModels();
							new Notice('Claudian model list refreshed.');
							this.display();
						} catch (error) {
							new Notice(`Could not refresh models: ${errorText(error)}`, 8000);
							button.setDisabled(false);
						}
					})();
				}));
			const addModelSetting = (name: string, desc: string, key: 'planningModel' | 'executionModel' | 'dailyReviewModel' | 'nightlyReviewModel') => new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addDropdown(dropdown => {
					dropdown.addOption('', models.length ? 'Select a model' : 'No models found - open Claudian');
					models.forEach(model => { dropdown.addOption(model.value, model.label); });
					const selected = this.plugin.settings[key] || '';
					dropdown.setValue(models.some(model => model.value === selected) ? selected : '');
					dropdown.onChange(value => {
						void (async () => {
							this.plugin.settings[key] = value;
							await this.plugin.saveState();
						})();
					});
				});
			addModelSetting('Planning model', 'Used when Ask AI to plan creates tasks and when AI updates a task.', 'planningModel');
			addModelSetting('Scheduled task model', 'Used when an enabled task runs, including tasks created by the planner.', 'executionModel');
			addModelSetting('Daily preview model', 'Used by Run daily preview.', 'dailyReviewModel');
			if (this.plugin.settings.nightlyReviewEnabled) {
				addModelSetting('Nightly review model', 'Used by the recurring nightly review and the Run AI nightly review now command.', 'nightlyReviewModel');
			}
		}

		new Setting(containerEl)
			.setName('Test notification')
			.setDesc('Send a normal Obsidian notification visible across the app, without using AI.')
			.addButton(button => button.setButtonText('Send test notification').onClick(() => this.plugin.testNotification()));

		new Setting(containerEl)
			.setName('Review context')
			.setDesc('Files the daily and nightly reviews may inspect through the active backend\'s vault tools.')
			.addDropdown(dropdown => dropdown
				.addOption('modified-today', 'Markdown files modified today')
				.addOption('all-markdown', 'All Markdown files')
				.addOption('no-files', 'No automatic files')
				.setValue(this.plugin.settings.reviewContextMode)
				.onChange(value => {
					void (async () => {
						this.plugin.settings.reviewContextMode = value as typeof this.plugin.settings.reviewContextMode;
						await this.plugin.saveState();
					})();
				}));

		new Setting(containerEl)
			.setName('Review report folder')
			.setDesc('Reports are saved as YYYY-MM-DD-HHmmss.md so every run is preserved.')
			.addText(text => text.setValue(this.plugin.settings.reportFolder).onChange(value => {
				void (async () => {
					this.plugin.settings.reportFolder = value.trim() || 'AI Reviews';
					await this.plugin.saveState();
				})();
			}));

		new Setting(containerEl)
			.setName('Nightly review')
			.setDesc('Opt-in: create a timestamped review report on a recurring schedule.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.nightlyReviewEnabled).onChange(value => {
				void (async () => {
					const previous = this.plugin.settings.nightlyReviewEnabled;
					try {
						this.plugin.settings.nightlyReviewEnabled = value;
						await this.plugin.ensureNightlyReviewJob();
						await this.plugin.saveState();
						new Notice(value ? 'Nightly review enabled.' : 'Nightly review disabled.');
						this.display();
					} catch (error) {
						this.plugin.settings.nightlyReviewEnabled = previous;
						toggle.setValue(previous);
						new Notice(`Could not change nightly review: ${errorText(error)}`, 8000);
					}
				})();
			}));

		if (this.plugin.settings.nightlyReviewEnabled) {
			new Setting(containerEl)
				.setName('Nightly review time')
				.setDesc('Local 24-hour time, for example 22:00.')
				.addText(text => text.setValue(this.plugin.settings.reviewTime).onChange(value => {
					void (async () => {
						if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) this.plugin.settings.reviewTime = value;
						await this.plugin.ensureNightlyReviewJob();
						await this.plugin.saveState();
					})();
				}));
		}

		new Setting(containerEl)
			.setName('Completion notifications')
			.setDesc('Show an Obsidian notice when an AI job finishes.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.notifyOnCompletion).onChange(value => {
				void (async () => {
					this.plugin.settings.notifyOnCompletion = value;
					await this.plugin.saveState();
				})();
			}));

		new Setting(containerEl)
			.setName('Run missed jobs after startup')
			.setDesc('Off by default. Enable only if you explicitly want AI work to run after Obsidian was closed.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.catchUpOnStart).onChange(value => {
				void (async () => {
					this.plugin.settings.catchUpOnStart = value;
					await this.plugin.saveState();
					this.display();
				})();
			}));

		if (this.plugin.settings.catchUpOnStart) {
			new Setting(containerEl)
				.setName('Startup catch-up window (hours)')
				.setDesc('Only jobs missed within this window will run after startup.')
				.addText(text => text.setValue(String(this.plugin.settings.catchUpHours)).onChange(value => {
					void (async () => {
						this.plugin.settings.catchUpHours = Math.max(1, Number.parseInt(value, 10) || 24);
						await this.plugin.saveState();
					})();
				}));
		}

		new Setting(containerEl).setName('Schedule notes (optional)').setHeading();
		new Setting(containerEl)
			.setName('Keep schedule notes in my vault')
			.setDesc('Off by default. When enabled, every task gets a Markdown note whose frontmatter holds its schedule and prompt — edit the note or the dashboard, both stay in sync. Task results and history stay in data.json, and turning this off never loses anything.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.scheduleNotesEnabled).onChange(value => {
				void (async () => {
					this.plugin.settings.scheduleNotesEnabled = value;
					await this.plugin.saveState();
					if (value) {
						try {
							const written = await this.plugin.notesSync.syncAll();
							new Notice(written ? `Schedule notes created or updated in ${this.plugin.settings.scheduleFolder}.` : 'Schedule notes are up to date.');
						} catch (error) {
							new Notice(`Could not write schedule notes: ${errorText(error)}`, 8000);
						}
					}
					this.display();
				})();
			}));

		if (this.plugin.settings.scheduleNotesEnabled) {
			new Setting(containerEl)
				.setName('Schedule notes folder')
				.setDesc('Existing notes keep working after a rename of this folder; new notes are created here.')
				.addText(text => text.setValue(this.plugin.settings.scheduleFolder).onChange(value => {
					void (async () => {
						this.plugin.settings.scheduleFolder = value.trim() || 'AI Schedules';
						await this.plugin.saveState();
					})();
				}));
			new Setting(containerEl)
				.setName('Sync notes now')
				.setDesc('Reconcile all task notes with the current schedule, including notes created by hand.')
				.addButton(button => button.setButtonText('Sync now').onClick(() => {
					void (async () => {
						button.setDisabled(true);
						try {
							const written = await this.plugin.notesSync.syncAll();
							new Notice(written ? `${written} note(s) reconciled.` : 'All schedule notes are up to date.');
						} catch (error) {
							new Notice(`Could not sync schedule notes: ${errorText(error)}`, 8000);
						}
						button.setDisabled(false);
					})();
				}));
		}
	}
}
