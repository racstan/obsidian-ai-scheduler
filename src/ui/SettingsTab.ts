import { PluginSettingTab, App, Setting, Notice, TextComponent } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { AISettings, BACKEND_INFO, BackendMode } from '../types';
import { errorText } from '../util';
import { ChangelogModal } from './ChangelogModal';
import { FolderSuggest } from './folderSuggest';

/** Adds the type-or-pick folder dropdown to a settings text field. */
function withFolderSuggest(app: App, text: TextComponent): TextComponent {
	new FolderSuggest(app, text.inputEl);
	return text;
}

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
		const mode = this.plugin.settings.backendMode;
		if (mode === 'none' || !mode) return;

		const info = BACKEND_INFO[mode === 'copilot' ? 'copilot' : 'claudian'];
		const setting = new Setting(containerEl)
			.setName('Backend connection status')
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
		const installed = mode === 'copilot'
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

	override display(): void {
		this.renderSettings();
	}

	renderSettings(): void {
		const { containerEl } = this;
		containerEl.empty();

		// -------------------------------------------------------------------------
		// Section 1: AI Backend & Models
		// -------------------------------------------------------------------------
		new Setting(containerEl).setName('AI backend & models').setHeading();
		containerEl.createEl('p', {
			text: 'Choose which AI plugin AI Scheduler uses to execute tasks, plan schedules, and generate reviews.',
			cls: 'ai-scheduler-subtitle',
		});

		new Setting(containerEl)
			.setName('AI backend')
			.setDesc('Select Claudian (for Claude and custom providers) or Obsidian Copilot (for OpenAI, Gemini, Ollama, etc.).')
			.addDropdown(dropdown => dropdown
				.addOption('none', 'Select an AI backend...')
				.addOption('claudian', 'Claudian')
				.addOption('copilot', 'Obsidian Copilot')
				.setValue(this.plugin.settings.backendMode || 'none')
				.onChange(value => {
					void (async () => {
						this.plugin.settings.backendMode = value as BackendMode;
						await this.plugin.saveState();
						this.renderSettings();
					})();
				}));

		const mode = this.plugin.settings.backendMode;

		if (mode === 'none' || !mode) {
			const infoBox = containerEl.createDiv({ cls: 'ai-scheduler-card ai-scheduler-card-flush' });
			infoBox.createDiv({
				cls: 'ai-scheduler-hint',
				text: '👉 Select an AI backend above to configure your AI models and connections. AI Scheduler connects to your installed Claudian or Obsidian Copilot plugin.',
			});
		} else if (mode === 'copilot') {
			this.renderBackendStatus(containerEl);
			const infoBox = containerEl.createDiv({ cls: 'ai-scheduler-card ai-scheduler-card-flush' });
			infoBox.createDiv({
				cls: 'ai-scheduler-hint',
				text: 'Obsidian Copilot uses the active model and provider configured inside the Copilot plugin settings.',
			});
		} else if (mode === 'claudian') {
			this.renderBackendStatus(containerEl);

			new Setting(containerEl)
				.setName('Available Claudian models')
				.setDesc('Refresh this list after adding, removing, or changing models in Claudian.')
				.addButton(button => button.setButtonText('Refresh models').onClick(() => {
					void (async () => {
						button.setDisabled(true);
						try {
							await this.plugin.refreshModels();
							new Notice('Claudian model list refreshed.');
							this.renderSettings();
						} catch (error) {
							new Notice(`Could not refresh models: ${errorText(error)}`, 8000);
							button.setDisabled(false);
						}
					})();
				}));

			const models = this.plugin.getModelOptions();

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
				addModelSetting('Periodic review model', 'Used by recurring periodic reviews and the Run AI periodic review now command.', 'nightlyReviewModel');
			}
		}

		// -------------------------------------------------------------------------
		// Section 2: Periodic Vault Reviews (Only visible when an AI backend is active)
		// -------------------------------------------------------------------------
		if (mode && mode !== 'none') {
			new Setting(containerEl).setName('Periodic vault reviews').setHeading();
			containerEl.createEl('p', {
				text: 'Autonomous vault intelligence: Periodically synthesizes notes created or modified across your vault and saves timestamped Markdown reports in your periodic review folder.',
				cls: 'ai-scheduler-subtitle',
			});

			const warningBox = containerEl.createDiv({ cls: 'ai-scheduler-warning-callout' });
			warningBox.createSpan({ cls: 'ai-scheduler-warning-icon', text: '⚠️' });
			const warningBody = warningBox.createDiv({ cls: 'ai-scheduler-warning-body' });
			warningBody.createDiv({
				cls: 'ai-scheduler-warning-title',
				text: 'Important note on computer sleep and scheduled tasks',
			});
			warningBody.createEl('p', {
				text: 'Periodic reviews and scheduled AI tasks execute locally inside Obsidian on your computer. If your computer is turned off or in sleep mode at the scheduled time, the review will not trigger. To automatically run missed reviews when you reopen Obsidian, turn on the setting to run missed jobs after startup below.',
			});

			new Setting(containerEl)
				.setName('Enable periodic AI review')
				.setDesc('Automated recurring synthesis: Reviews recent notes and vault changes according to your chosen frequency, saving timestamped summaries to your periodic review folder.')
				.addToggle(toggle => toggle.setValue(this.plugin.settings.nightlyReviewEnabled).onChange(value => {
					void (async () => {
						const previous = this.plugin.settings.nightlyReviewEnabled;
						try {
							this.plugin.settings.nightlyReviewEnabled = value;
							await this.plugin.ensurePeriodicReviewJob();
							await this.plugin.saveState();
							new Notice(value ? 'Periodic AI review enabled.' : 'Periodic AI review disabled.');
							this.renderSettings();
						} catch (error) {
							this.plugin.settings.nightlyReviewEnabled = previous;
							toggle.setValue(previous);
							new Notice(`Could not change periodic review: ${errorText(error)}`, 8000);
						}
					})();
				}));

			if (this.plugin.settings.nightlyReviewEnabled) {
				new Setting(containerEl)
					.setName('Review frequency & cadence')
					.setDesc('Choose how often the periodic review should execute.')
					.addDropdown(dropdown => dropdown
						.addOption('daily', 'Daily (at chosen time)')
						.addOption('weekly', 'Weekly (on specific days)')
						.addOption('every-n-days', 'Every n days')
						.addOption('hourly', 'Hourly / interval (every n hours)')
						.setValue(this.plugin.settings.periodicReviewCadence || 'daily')
						.onChange(value => {
							void (async () => {
								this.plugin.settings.periodicReviewCadence = value as AISettings['periodicReviewCadence'];
								await this.plugin.ensurePeriodicReviewJob();
								await this.plugin.saveState();
								this.renderSettings();
							})();
						}));

				const cadence = this.plugin.settings.periodicReviewCadence || 'daily';

				if (cadence === 'daily' || cadence === 'weekly' || cadence === 'every-n-days') {
					new Setting(containerEl)
						.setName('Execution time (24h hh:mm)')
						.setDesc('Local 24-hour time when the review runs (for example, 22:00 or 09:30).')
						.addText(text => text.setValue(this.plugin.settings.reviewTime).onChange(value => {
							void (async () => {
								if (/^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
									this.plugin.settings.reviewTime = value.trim();
									await this.plugin.ensurePeriodicReviewJob();
									await this.plugin.saveState();
								}
							})();
						}));
				}

				if (cadence === 'every-n-days') {
					new Setting(containerEl)
						.setName('Interval in days')
						.setDesc('Run the review once every n days (for example, 2 for every other day, 3 for every 3 days).')
						.addText(text => text
							.setValue(String(this.plugin.settings.periodicReviewEveryDays || 2))
							.onChange(value => {
								void (async () => {
									const n = parseInt(value.trim(), 10);
									if (Number.isInteger(n) && n >= 1) {
										this.plugin.settings.periodicReviewEveryDays = n;
										await this.plugin.ensurePeriodicReviewJob();
										await this.plugin.saveState();
									}
								})();
							}));
				}

				if (cadence === 'hourly') {
					new Setting(containerEl)
						.setName('Interval in hours')
						.setDesc('Run the review every n hours (for example, 6 for every 6 hours, 12 for twice a day).')
						.addText(text => text
							.setValue(String(this.plugin.settings.periodicReviewHours || 12))
							.onChange(value => {
								void (async () => {
									const n = parseInt(value.trim(), 10);
									if (Number.isInteger(n) && n >= 1) {
										this.plugin.settings.periodicReviewHours = n;
										await this.plugin.ensurePeriodicReviewJob();
										await this.plugin.saveState();
									}
								})();
							}));
				}

				if (cadence === 'weekly') {
					const daysContainer = new Setting(containerEl)
						.setName('Days of the week')
						.setDesc('Select the days on which the review should run. At least one day stays selected.');
					daysContainer.controlEl.addClass('ai-scheduler-day-toggles');

					const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
					const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
					const selectedDays = new Set(this.plugin.settings.periodicReviewDays || [1]);

					dayLabels.forEach((label, idx) => {
						// Visible day name next to each toggle (they are otherwise indistinguishable).
						daysContainer.controlEl.createSpan({ cls: 'ai-scheduler-day-toggle-label', text: label });
						daysContainer.addToggle(toggle => {
							toggle.toggleEl.setAttribute('aria-label', `Run review on ${dayNames[idx]}`);
							toggle
								.setTooltip(dayNames[idx])
								.setValue(selectedDays.has(idx))
								.onChange(checked => {
									void (async () => {
										if (checked) {
											selectedDays.add(idx);
										} else if (selectedDays.size === 1 && selectedDays.has(idx)) {
											// Keep at least one day: switch this toggle back on.
											toggle.setValue(true);
											new Notice('Select at least one day for the weekly review.');
											return;
										} else {
											selectedDays.delete(idx);
										}
										this.plugin.settings.periodicReviewDays = Array.from(selectedDays).sort((a, b) => a - b);
										await this.plugin.ensurePeriodicReviewJob();
										await this.plugin.saveState();
									})();
								});
						});
					});
				}

				new Setting(containerEl)
					.setName('Review context')
					.setDesc('Files the periodic review may inspect through the active backend\'s vault tools.')
					.addDropdown(dropdown => dropdown
						.addOption('modified-today', 'Markdown files modified recently / today')
						.addOption('all-markdown', 'All Markdown files')
						.addOption('no-files', 'No automatic files')
						.setValue(this.plugin.settings.reviewContextMode)
						.onChange(value => {
							void (async () => {
								this.plugin.settings.reviewContextMode = value as typeof this.plugin.settings.reviewContextMode;
								await this.plugin.saveState();
							})();
						}));

				const defaultReviewFolder = `${this.plugin.getDefaultOutputFolder()}/Periodic Reviews`;
				new Setting(containerEl)
					.setName('Periodic review folder')
					.setDesc(`Vault folder where periodic review summaries are saved. Defaults to "${defaultReviewFolder}". Each review creates a timestamped Markdown file (e.g. YYYY-MM-DD-HHmmss.md) so past summaries are permanently preserved.`)
					.addText(text => withFolderSuggest(this.app, text)
						.setPlaceholder(defaultReviewFolder)
						.setValue(this.plugin.settings.reportFolder)
						.onChange(value => {
							void (async () => {
								this.plugin.settings.reportFolder = value.trim();
								await this.plugin.saveState();
							})();
						}));

				new Setting(containerEl)
					.setName('Run periodic review now')
					.setDesc('Manually trigger the full periodic review routine immediately without waiting for the scheduled time.')
					.addButton(button => button.setButtonText('Run review now').onClick(() => {
						void this.plugin.startReviewRun(true, 'periodic');
					}));
			}
		}

		// -------------------------------------------------------------------------
		// Section 3: Default Output & Task Logging
		// -------------------------------------------------------------------------
		new Setting(containerEl).setName('Task outputs & activity logging').setHeading();

		new Setting(containerEl)
			.setName('Default output folder')
			.setDesc('Vault folder where AI task results are saved when a prompt does not specify a save location. If empty, defaults to "AI Scheduler".')
			.addText(text => withFolderSuggest(this.app, text)
				.setPlaceholder('AI Scheduler')
				.setValue(this.plugin.settings.defaultOutputFolder)
				.onChange(value => {
					void (async () => {
						this.plugin.settings.defaultOutputFolder = value.trim();
						await this.plugin.saveState();
					})();
				}));

		new Setting(containerEl)
			.setName('Enable task activity logging')
			.setDesc('Record every task execution in a centralized Markdown log table with serial number, timestamp, execution status, and links to modified/created files.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.taskLoggingEnabled)
				.onChange(value => {
					void (async () => {
						this.plugin.settings.taskLoggingEnabled = value;
						await this.plugin.saveState();
						this.renderSettings();
					})();
				}));

		if (this.plugin.settings.taskLoggingEnabled) {
			new Setting(containerEl)
				.setName('Task log folder')
				.setDesc('Vault folder where "AI SCHEDULER LOGS.md" is stored. Leave blank to use the default output folder.')
				.addText(text => withFolderSuggest(this.app, text)
					.setPlaceholder(this.plugin.getDefaultOutputFolder())
					.setValue(this.plugin.settings.taskLogFolder)
					.onChange(value => {
						void (async () => {
							this.plugin.settings.taskLogFolder = value.trim();
							await this.plugin.saveState();
						})();
					}));
		}

		// -------------------------------------------------------------------------
		// Section 4: Background Execution & Notifications
		// -------------------------------------------------------------------------
		new Setting(containerEl).setName('Background execution & notifications').setHeading();

		new Setting(containerEl)
			.setName('In-app completion notices')
			.setDesc('Show an Obsidian notice when an AI job or review finishes.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.notifyOnCompletion).onChange(value => {
				void (async () => {
					this.plugin.settings.notifyOnCompletion = value;
					await this.plugin.saveState();
				})();
			}));

		new Setting(containerEl)
			.setName('System desktop notifications')
			.setDesc('Send native OS desktop notifications (Windows / macOS / Linux) when tasks finish or fail.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.systemNotifications).onChange(value => {
				void (async () => {
					this.plugin.settings.systemNotifications = value;
					await this.plugin.saveState();
				})();
			}));

		new Setting(containerEl)
			.setName('Test notifications')
			.setDesc('Send a test alert to verify both Obsidian in-app notices and system desktop notifications.')
			.addButton(button => button.setButtonText('Send test notification').onClick(() => this.plugin.testNotification()));

		new Setting(containerEl)
			.setName('Run missed jobs after startup')
			.setDesc('Off by default. Enable only if you explicitly want AI work to run after Obsidian was closed.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.catchUpOnStart).onChange(value => {
				void (async () => {
					this.plugin.settings.catchUpOnStart = value;
					await this.plugin.saveState();
					this.renderSettings();
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

		// -------------------------------------------------------------------------
		// Section 4: Vault Schedule Notes Sync
		// -------------------------------------------------------------------------
		new Setting(containerEl).setName('Vault schedule notes (optional)').setHeading();
		new Setting(containerEl)
			.setName('Keep schedule notes in my vault')
			.setDesc('Off by default. When enabled, every task gets a Markdown note whose frontmatter holds its schedule and prompt — edit the note or the dashboard, both stay in sync. Note: deleting a task note in Obsidian permanently removes that task.')
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
					this.renderSettings();
				})();
			}));

		if (this.plugin.settings.scheduleNotesEnabled) {
			new Setting(containerEl)
				.setName('Schedule notes folder')
				.setDesc('Existing notes keep working after a rename of this folder; new notes are created here.')
				.addText(text => withFolderSuggest(this.app, text).setValue(this.plugin.settings.scheduleFolder).onChange(value => {
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

		// -------------------------------------------------------------------------
		// Section 5: Updates & Changelog
		// -------------------------------------------------------------------------
		new Setting(containerEl).setName('Updates & release notes').setHeading();
		new Setting(containerEl)
			.setName('Show changelog after updates')
			.setDesc('Automatically open the what\'s new dialog when AI Scheduler is updated.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.showChangelogOnUpdate).onChange(value => {
				void (async () => {
					this.plugin.settings.showChangelogOnUpdate = value;
					await this.plugin.saveState();
				})();
			}));

		new Setting(containerEl)
			.setName('View changelog')
			.setDesc('Browse recent changes and complete release history starting from v2.0.0.')
			.addButton(button => button.setButtonText('View what\'s new').onClick(() => {
				new ChangelogModal(this.app, this.plugin).open();
			}));

		// -------------------------------------------------------------------------
		// Section 6: Help & Community
		// -------------------------------------------------------------------------
		new Setting(containerEl).setName('Help & community').setHeading();
		new Setting(containerEl)
			.setName('Facing a problem?')
			.setDesc('Found a bug or have a suggestion? Create an issue on GitHub to get help from the community.')
			.addButton(button => button.setButtonText('Report an issue').onClick(() => {
				window.open('https://github.com/racstan/obsidian-ai-scheduler/issues', '_blank');
			}));

		// -------------------------------------------------------------------------
		// Section 7: About
		// -------------------------------------------------------------------------
		new Setting(containerEl).setName('About').setHeading();

		const aboutCard = containerEl.createDiv({ cls: 'ai-scheduler-about-card' });
		const aboutHeader = aboutCard.createDiv({ cls: 'ai-scheduler-about-header' });
		aboutHeader.createDiv({ text: 'AI Scheduler for Obsidian', cls: 'ai-scheduler-about-title' });
		aboutHeader.createSpan({ text: `v${this.plugin.manifest.version}`, cls: 'ai-scheduler-version-badge is-latest' });

		aboutCard.createEl('p', {
			text: 'The autonomous background scheduling and proactive intelligence engine for Obsidian. Turn your vault into an active thinking partner that plans, reviews, executes, and synthesizes your knowledge in the background.',
			cls: 'ai-scheduler-about-desc',
		});

		const metaRow = aboutCard.createDiv({ cls: 'ai-scheduler-about-meta' });
		const authorEl = metaRow.createSpan({ text: 'Author: ' });
		const authorLink = authorEl.createEl('a', { text: '@racstan', href: 'https://github.com/racstan' });
		authorLink.target = '_blank';
		metaRow.createSpan({ text: ' · ' });
		metaRow.createSpan({ text: 'License: PolyForm Noncommercial 1.0.0' });
		metaRow.createSpan({ text: ' · ' });
		const ghLink = metaRow.createEl('a', { text: 'GitHub repository', href: 'https://github.com/racstan/obsidian-ai-scheduler' });
		ghLink.target = '_blank';

		new Setting(containerEl)
			.setName('Documentation & source code')
			.setDesc('Read the setup guide, contribute, or star the project on GitHub.')
			.addButton(button => button.setButtonText('View on GitHub').onClick(() => {
				window.open('https://github.com/racstan/obsidian-ai-scheduler', '_blank');
			}));
	}
}
