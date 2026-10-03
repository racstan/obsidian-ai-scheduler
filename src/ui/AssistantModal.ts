import { App, Modal, Notice, Setting } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { formatDate, formatDuration, describeBinding, isDisabledTask, isNightlyReviewJob, summarizeTasks } from '../util';
import { describeSchedule } from '../schedule';
import { closeExistingSchedulerModals, makeButton, makeCard } from './dom';
import { JobModal } from './JobModal';
import { PlannerModal } from './PlannerModal';
import { TaskViewModal } from './TaskViewModal';

function appendTaskIdBadge(container: HTMLElement, id: string): void {
	const idBadge = container.createSpan({ cls: 'ai-scheduler-task-id-badge', text: `ID: ${id}` });
	idBadge.setAttribute('title', 'Click to copy task ID');
	idBadge.onclick = (e) => {
		e.stopPropagation();
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			void navigator.clipboard.writeText(id).then(() => {
				new Notice(`Copied Task ID: ${id}`);
			});
		}
	};
}

export class ConfirmModal extends Modal {
	constructor(app: App, public message: string, public onConfirm: () => void) {
		super(app);
	}
	onOpen(): void {
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-confirm-modal');
		this.contentEl.createEl('h3', { text: 'Confirm' });
		this.contentEl.createEl('p', { text: this.message });
		new Setting(this.contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(btn => btn.setButtonText('Confirm').setCta().onClick(() => {
				this.onConfirm();
				this.close();
			}));
	}
	onClose(): void {
		this.contentEl.empty();
	}
}

export class AssistantModal extends Modal {
	plugin: AISchedulerPlugin;
	private refreshTimer: number | null = null;

	constructor(app: AISchedulerPlugin['app'], plugin: AISchedulerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		closeExistingSchedulerModals(this);
		this.render();
		// Live auto-refresh every 3s so task progress and state transitions update in real time
		this.refreshTimer = window.setInterval(() => {
			this.render();
		}, 3000);
	}

	render(): void {
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-lg');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv('ai-scheduler-shell ai-scheduler-shell-lg');
		shell.createEl('h1', { text: 'AI Scheduler' }).addClass('ai-scheduler-title');
		shell.createEl('p', { text: 'Plan work, run reviews, and manage scheduled tasks from one place.' }).addClass('ai-scheduler-subtitle');

		const readiness = this.plugin.getBackendReadiness();
		if (!readiness.ok) {
			const banner = shell.createDiv('ai-scheduler-alert-banner');
			const content = banner.createDiv('ai-scheduler-alert-content');
			content.createSpan('ai-scheduler-alert-icon').setText('⚠️');
			const textCol = content.createDiv();
			textCol.createDiv('ai-scheduler-alert-title').setText('AI backend not configured');
			textCol.createDiv('ai-scheduler-alert-desc').setText(readiness.message);
			const btn = banner.createEl('button', { text: 'Open settings', cls: 'mod-cta ai-scheduler-alert-btn' });
			btn.onclick = () => {
				this.close();
				window.setTimeout(() => {
					this.plugin.openSettingsTab();
				}, 50);
			};
		}

		const actions = shell.createDiv('ai-scheduler-actions');
		makeButton(actions, '✨ Ask AI to plan', () => {
			this.close();
			window.setTimeout(() => {
				new PlannerModal(this.app, this.plugin).open();
			}, 50);
		}, true);
		makeButton(actions, '⚙️ Settings', () => {
			this.close();
			window.setTimeout(() => {
				this.plugin.openSettingsTab();
			}, 50);
		});

		const userJobs = this.plugin.jobs.filter(job => !isNightlyReviewJob(job));
		const activeCount = userJobs.filter(job => job.enabled).length;
		const pausedCount = userJobs.filter(job => !job.enabled).length;
		const runningJobs = userJobs.filter(job => job.status === 'running' || this.plugin.runningJobs.has(job.id));
		const next = userJobs.filter(job => job.enabled && job.nextRunAt && job.status !== 'running').sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime())[0];

		const stats = shell.createDiv({ cls: 'ai-scheduler-stats' });

		// Stat 1: Active tasks
		const statActive = makeCard(stats, 'ai-scheduler-card-stat');
		statActive.createDiv({ cls: 'ai-scheduler-stat-value', text: String(activeCount) });
		statActive.createDiv({ cls: 'ai-scheduler-stat-label', text: 'ACTIVE TASKS' });

		// Stat 2: Paused / Past
		const statPaused = makeCard(stats, 'ai-scheduler-card-stat');
		statPaused.createDiv({ cls: 'ai-scheduler-stat-value', text: String(pausedCount) });
		statPaused.createDiv({ cls: 'ai-scheduler-stat-label', text: 'PAUSED / PAST' });

		// Stat 3: Running or Next run
		const statThird = makeCard(stats, 'ai-scheduler-card-stat');
		if (runningJobs.length > 0) {
			statThird.addClass('ai-scheduler-stat-running');
			statThird.createDiv({ cls: 'ai-scheduler-stat-value ai-scheduler-text-running', text: `${runningJobs.length} Running` });
			statThird.createDiv({ cls: 'ai-scheduler-stat-label', text: 'EXECUTING IN BACKGROUND' });
		} else {
			statThird.createDiv({ cls: 'ai-scheduler-stat-value', text: next ? formatDate(next.nextRunAt) : 'None' });
			statThird.createDiv({ cls: 'ai-scheduler-stat-label', text: next ? `NEXT RUN: #${next.taskNumber} ${next.title.slice(0, 18)}` : 'SOONEST RUN' });
		}

		this.renderSection(shell, 'Scheduled tasks', `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'} enabled`);
		const bulkActions = shell.createDiv({ cls: 'ai-scheduler-row-actions' });
		makeButton(bulkActions, 'Enable all', () => {
			if (!userJobs.length) {
				new Notice('No tasks available.');
				return;
			}
			new ConfirmModal(this.app, 'Enable all scheduled tasks?', () => {
				void (async () => {
					const count = await this.plugin.enableAllJobs();
					new Notice(count > 0 ? `${count} scheduled task(s) enabled.` : 'All scheduled tasks are already enabled.');
					this.render();
				})();
			}).open();
		});
		makeButton(bulkActions, 'Disable all', () => {
			if (!userJobs.length) {
				new Notice('No tasks available.');
				return;
			}
			new ConfirmModal(this.app, 'Disable all scheduled tasks?', () => {
				void (async () => {
					const count = await this.plugin.disableAllJobs();
					new Notice(count > 0 ? `${count} scheduled task(s) disabled.` : 'All scheduled tasks are already disabled.');
					this.render();
				})();
			}).open();
		}, false, false);
		makeButton(bulkActions, 'Delete all', () => {
			if (!userJobs.length) {
				new Notice('No tasks available.');
				return;
			}
			new ConfirmModal(this.app, 'Delete all scheduled tasks? This cannot be undone.', () => {
				void (async () => {
					const count = await this.plugin.deleteAllJobs();
					new Notice(count > 0 ? `${count} scheduled task(s) deleted.` : 'No tasks available.');
					this.render();
				})();
			}).open();
		}, false, true);

		const scheduled = userJobs.filter(job => job.enabled).sort((a, b) => {
			if (a.status === 'running' && b.status !== 'running') return -1;
			if (b.status === 'running' && a.status !== 'running') return 1;
			return String(a.nextRunAt).localeCompare(String(b.nextRunAt));
		});

		const jobsContainer = shell.createDiv();
		if (!scheduled.length) {
			const empty = makeCard(jobsContainer, 'ai-scheduler-card-muted');
			empty.createDiv({ text: 'No scheduled tasks yet.' });
			empty.createDiv({ cls: 'ai-scheduler-empty-sub', text: 'Ask AI to plan a schedule from a plain-language goal.' });
		}

		for (const job of scheduled) {
			const isRunning = job.status === 'running' || this.plugin.runningJobs.has(job.id);
			const card = makeCard(jobsContainer, 'ai-scheduler-task-card');
			if (isRunning) card.addClass('ai-scheduler-task-running');

			const copy = card.createDiv();
			const titleRow = copy.createDiv({ cls: 'ai-scheduler-task-header' });
			titleRow.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
			appendTaskIdBadge(titleRow, job.id);

			if (isRunning) {
				const badge = titleRow.createSpan({ cls: 'ai-scheduler-status-badge ai-scheduler-status-running' });
				badge.createSpan({ cls: 'ai-scheduler-spinner-tiny' });
				badge.createSpan({ text: 'Running in background...' });
			}

			copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${describeSchedule(job)}${job.runCount ? ` · ${job.runCount} run${job.runCount === 1 ? '' : 's'}` : ''}` });

			if (isRunning) {
				const runInfo = copy.createDiv({ cls: 'ai-scheduler-task-next ai-scheduler-text-running' });
				const startTime = job.lastRunAt || job.nextRunAt || new Date().toISOString();
				runInfo.setText(`Started execution at ${formatDate(startTime)} (${formatDuration(startTime)} elapsed) · AI is generating results`);
			} else {
				const nextText = job.nextRunAt ? `Next run: ${formatDate(job.nextRunAt)}` : (job.schedule.kind === 'event' ? 'Trigger: On vault note modification' : '⏰ Next run: Not scheduled');
				copy.createDiv({ cls: 'ai-scheduler-task-next', text: `⏰ ${nextText}` });
			}

			const controls = card.createDiv({ cls: 'ai-scheduler-task-actions' });

			if (isRunning) {
				makeButton(controls, '⏹️ Reset / Stop', () => {
					new ConfirmModal(
						this.app,
						`Reset and stop running task #${job.taskNumber} (${job.title})? If the AI backend is currently processing, it will be marked as cancelled/failed.`,
						() => {
							void (async () => {
								await this.plugin.resetRunningJob(job);
								new Notice(`Reset task #${job.taskNumber}.`);
								this.render();
							})();
						}
					).open();
				}, false, true);
			} else {
				makeButton(controls, '▶️ Run now', () => {
					new ConfirmModal(
						this.app,
						`Run task #${job.taskNumber} (${job.title}) immediately? This will trigger background execution right now without waiting for its scheduled time slot.`,
						() => {
							void (async () => {
								new Notice(`Starting task #${job.taskNumber} now...`);
								await this.plugin.runJobNow(job);
								this.render();
							})();
						}
					).open();
				});
			}

			makeButton(controls, 'Edit', () => {
				this.close();
				window.setTimeout(() => {
					new JobModal(this.app, this.plugin, job, () => {
						new AssistantModal(this.app, this.plugin).open();
					}).open();
				}, 50);
			});

			if (!isRunning) {
				makeButton(controls, 'Disable', async () => {
					job.enabled = false;
					job.nextRunAt = null;
					job.status = 'disabled';
					job.lastStatus = 'disabled';
					await this.plugin.saveState();
					this.render();
				}, false, false);
			}

			makeButton(controls, 'Delete', () => {
				new ConfirmModal(this.app, `Delete task #${job.taskNumber}? This cannot be undone.`, () => {
					void (async () => {
						await this.plugin.deleteJob(job);
						this.render();
					})();
				}).open();
			}, false, true);
		}

		const disabled = summarizeTasks(userJobs.filter(job => isDisabledTask(job))).slice(-8).reverse();
		if (disabled.length) {
			this.renderSection(shell, 'Disabled tasks', 'Paused and ready to enable');
			const disabledList = shell.createDiv();
			for (const job of disabled) {
				const card = makeCard(disabledList, 'ai-scheduler-task-card');
				const copy = card.createDiv();
				const titleRow = copy.createDiv({ cls: 'ai-scheduler-task-header' });
				titleRow.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
				appendTaskIdBadge(titleRow, job.id);

				copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${describeSchedule(job)}` });
				copy.createDiv({ cls: 'ai-scheduler-task-paused', text: '⏸️ Paused (click Enable to schedule next run)' });
				const controls = card.createDiv({ cls: 'ai-scheduler-task-actions' });
				makeButton(controls, 'Edit', () => {
					this.close();
					window.setTimeout(() => {
						new JobModal(this.app, this.plugin, job, () => {
							new AssistantModal(this.app, this.plugin).open();
						}).open();
					}, 50);
				});
				makeButton(controls, 'Enable', async () => {
					await this.plugin.enableJob(job);
					this.render();
				});
				makeButton(controls, 'Delete', () => {
					new ConfirmModal(this.app, `Delete task #${job.taskNumber}? This cannot be undone.`, () => {
						void (async () => {
							await this.plugin.deleteJob(job);
							this.render();
						})();
					}).open();
				}, false, true);
			}
		}

		const past = summarizeTasks(userJobs.filter(job => !job.enabled && !isDisabledTask(job))).slice(-8).reverse();
		if (past.length) {
			this.renderSection(shell, 'Past tasks', 'Completed or failed tasks, summarized per task');
			const pastList = shell.createDiv();
			for (const job of past) {
				const card = makeCard(pastList, 'ai-scheduler-task-card');
				const copy = card.createDiv();
				const titleRow = copy.createDiv({ cls: 'ai-scheduler-task-header' });
				titleRow.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
				appendTaskIdBadge(titleRow, job.id);

				copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${job.lastStatus || job.status || 'completed'}${job.runCount ? ` · ${job.runCount} run${job.runCount === 1 ? '' : 's'}` : ''}` });
				if (job.lastRunAt) {
					copy.createDiv({ cls: 'ai-scheduler-task-paused', text: `Last ran: ${formatDate(job.lastRunAt)}` });
				}
				const controls = card.createDiv('ai-scheduler-task-actions');
				makeButton(controls, 'View', () => {
					this.close();
					window.setTimeout(() => {
						new TaskViewModal(this.app, this.plugin, job, () => {
							new AssistantModal(this.app, this.plugin).open();
						}).open();
					}, 50);
				});
				makeButton(controls, 'Run again', () => {
					new ConfirmModal(
						this.app,
						`Run task #${job.taskNumber} (${job.title}) immediately? It will execute right now in the background and will no longer be marked as past/missed.`,
						() => {
							void (async () => {
								new Notice(`Starting task #${job.taskNumber} now...`);
								await this.plugin.retryJob(job);
								this.render();
							})();
						}
					).open();
				});
				makeButton(controls, 'Delete', () => {
					new ConfirmModal(this.app, `Delete task #${job.taskNumber}? This cannot be undone.`, () => {
						void (async () => {
							await this.plugin.deleteJob(job);
							this.render();
						})();
					}).open();
				}, false, true);
			}
		}

		const activity = this.plugin.activity.slice(-20).reverse();
		const activityHeading = this.renderSection(shell, 'Recent activity', activity.length ? 'All times are local' : 'No activity yet');
		makeButton(activityHeading, 'Clear', async button => {
			button.disabled = true;
			await this.plugin.clearActivity();
			this.render();
		});
		const activityContainer = shell.createDiv('ai-scheduler-activity-scroll-window');
		if (!activity.length) {
			const empty = activityContainer.createDiv('ai-scheduler-activity-empty');
			empty.setText('Reviews, task runs, and notifications will appear here.');
		} else {
			for (const event of activity) {
				const row = activityContainer.createDiv('ai-scheduler-activity-row');
				const left = row.createDiv({ cls: 'ai-scheduler-activity-left' });
				const badge = left.createSpan({ cls: `ai-scheduler-act-badge ai-scheduler-act-${event.type || 'info'}` });
				badge.setText(this.getActivityTypeLabel(event.type));
				left.createSpan({ text: event.message, cls: 'ai-scheduler-activity-msg' });
				row.createSpan({ text: formatDate(event.at) }).addClass('ai-scheduler-activity-time');
			}
		}
	}

	private getActivityTypeLabel(type: string): string {
		switch (type) {
			case 'running': return 'RUNNING';
			case 'completed': return '✅ DONE';
			case 'failed': return '❌ FAILED';
			case 'planned': return '✨ PLANNED';
			case 'cancelled': return '⏹️ RESET';
			case 'deleted': return '🗑️ DELETED';
			case 'status': return 'ℹ️ STATUS';
			default: return 'LOG';
		}
	}

	renderSection(parent: HTMLElement, title: string, description: string): HTMLDivElement {
		const heading = parent.createDiv('ai-scheduler-section-heading');
		heading.createEl('h2', { text: title }).addClass('ai-scheduler-section-title');
		heading.createSpan({ text: description }).addClass('ai-scheduler-section-desc');
		return heading;
	}

	onClose(): void {
		if (this.refreshTimer) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.contentEl.empty();
	}
}
