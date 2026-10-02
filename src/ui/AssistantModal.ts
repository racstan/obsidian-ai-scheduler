import { App, Modal, Notice, Setting } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { formatDate, describeBinding, isDisabledTask, isNightlyReviewJob, summarizeTasks } from '../util';
import { describeSchedule } from '../schedule';
import { makeButton, makeCard } from './dom';
import { JobModal } from './JobModal';
import { PlannerModal } from './PlannerModal';

export class ConfirmModal extends Modal {
	constructor(app: App, public message: string, public onConfirm: () => void) {
		super(app);
	}
	onOpen(): void {
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

	constructor(app: AISchedulerPlugin['app'], plugin: AISchedulerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void { this.render(); }

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
				new PlannerModal(this.app, this.plugin, () => new AssistantModal(this.app, this.plugin).open()).open();
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
		const next = userJobs.filter(job => job.enabled && job.nextRunAt).sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime())[0];
		const stats = shell.createDiv({ cls: 'ai-scheduler-stats' });
		[
			[activeCount, 'ACTIVE TASKS'],
			[pausedCount, 'PAUSED / PAST'],
			[next ? formatDate(next.nextRunAt) : 'None', next ? `NEXT RUN: #${next.taskNumber} ${next.title.slice(0, 18)}` : 'SOONEST RUN'],
		].forEach(([value, label]) => {
			const stat = makeCard(stats, 'ai-scheduler-card-stat');
			stat.createDiv({ cls: 'ai-scheduler-stat-value', text: String(value) });
			stat.createDiv({ cls: 'ai-scheduler-stat-label', text: label as string });
		});

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
		const scheduled = userJobs.filter(job => job.enabled).sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
		const jobs = shell.createDiv();
		if (!scheduled.length) {
			const empty = makeCard(jobs, 'ai-scheduler-card-muted');
			empty.createDiv({ text: 'No scheduled tasks yet.' });
			empty.createDiv({ cls: 'ai-scheduler-empty-sub', text: 'Ask AI to plan a schedule from a plain-language goal.' });
		}
		for (const job of scheduled) {
			const card = makeCard(jobs, 'ai-scheduler-task-card');
			const copy = card.createDiv();
			copy.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
			copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${describeSchedule(job)}${job.runCount ? ` · ${job.runCount} run${job.runCount === 1 ? '' : 's'}` : ''}` });
			const nextText = job.nextRunAt ? `Next run: ${formatDate(job.nextRunAt)}` : (job.schedule.kind === 'event' ? '⚡ Trigger: On vault note modification' : '⏰ Next run: Not scheduled');
			copy.createDiv({ cls: 'ai-scheduler-task-next', text: `⏰ ${nextText}` });
			const controls = card.createDiv({ cls: 'ai-scheduler-task-actions' });
			makeButton(controls, 'Edit', () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
			makeButton(controls, 'Disable', async () => {
				job.enabled = false;
				job.nextRunAt = null;
				job.status = 'disabled';
				job.lastStatus = 'disabled';
				await this.plugin.saveState();
				this.render();
			}, false, false);
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
				copy.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
				copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${describeSchedule(job)}` });
				copy.createDiv({ cls: 'ai-scheduler-task-paused', text: '⏸️ Paused (click Enable to schedule next run)' });
				const controls = card.createDiv({ cls: 'ai-scheduler-task-actions' });
				makeButton(controls, 'Edit', () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
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
				copy.createDiv({ cls: 'ai-scheduler-task-title', text: `#${job.taskNumber} · ${job.title}` });
				copy.createDiv({ cls: 'ai-scheduler-task-meta', text: `${describeBinding(job)} · ${job.lastStatus || job.status || 'completed'}${job.runCount ? ` · ${job.runCount} run${job.runCount === 1 ? '' : 's'}` : ''}` });
				if (job.lastRunAt) {
					copy.createDiv({ cls: 'ai-scheduler-task-paused', text: `Last ran: ${formatDate(job.lastRunAt)}` });
				}
				const controls = card.createDiv('ai-scheduler-task-actions');
				makeButton(controls, 'Edit', () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
				makeButton(controls, 'Run again', async () => { await this.plugin.retryJob(job); this.render(); });
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
				row.createSpan({ text: event.message });
				row.createSpan({ text: formatDate(event.at) }).addClass('ai-scheduler-activity-time');
			}
		}
	}

	renderSection(parent: HTMLElement, title: string, description: string): HTMLDivElement {
		const heading = parent.createDiv('ai-scheduler-section-heading');
		heading.createEl('h2', { text: title }).addClass('ai-scheduler-section-title');
		heading.createSpan({ text: description }).addClass('ai-scheduler-section-desc');
		return heading;
	}

	onClose(): void { this.contentEl.empty(); }
}
