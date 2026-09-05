import { Modal } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { formatDate, describeBinding, isDisabledTask, isNightlyReviewJob, summarizeTasks } from '../util';
import { describeSchedule } from '../schedule';
import { makeButton, makeCard } from './dom';
import { JobModal } from './JobModal';
import { PlannerModal } from './PlannerModal';

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

		const actions = shell.createDiv('ai-scheduler-actions');
		makeButton(actions, 'Ask AI to plan', () => new PlannerModal(this.app, this.plugin).open(), true);
		makeButton(actions, 'Run daily preview', () => this.plugin.startReviewRun(true, 'daily'));

		const userJobs = this.plugin.jobs.filter(job => !isNightlyReviewJob(job));
		const activeCount = userJobs.filter(job => job.enabled).length;
		const next = userJobs.filter(job => job.enabled && job.nextRunAt).sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime())[0];
		const stats = shell.createDiv('ai-scheduler-stats');
		[[activeCount, 'ACTIVE TASKS'], [next ? formatDate(next.nextRunAt) : 'None', 'NEXT RUN'], [this.plugin.settings.nightlyReviewEnabled ? 'ON' : 'OFF', 'NIGHTLY REVIEW']].forEach(([value, label]) => {
			const stat = makeCard(stats, 'ai-scheduler-card-stat');
			stat.createDiv({ text: String(value) }).addClass('ai-scheduler-stat-value');
			stat.createDiv({ text: label as string }).addClass('ai-scheduler-stat-label');
		});

		this.renderSection(shell, 'Scheduled tasks', `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'} enabled`);
		const bulkActions = shell.createDiv('ai-scheduler-row-actions');
		makeButton(bulkActions, 'Enable all', async () => {
			await this.plugin.enableAllJobs();
			this.render();
		});
		makeButton(bulkActions, 'Disable all', async () => {
			if (!window.confirm('Disable all scheduled tasks?')) return;
			await this.plugin.disableAllJobs();
			this.render();
		}, false, true);
		makeButton(bulkActions, 'Delete all', async () => {
			if (!window.confirm('Delete all scheduled tasks? This cannot be undone.')) return;
			await this.plugin.deleteAllJobs();
			this.render();
		}, false, true);
		const scheduled = userJobs.filter(job => job.enabled).sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));
		const jobs = shell.createDiv();
		if (!scheduled.length) {
			const empty = makeCard(jobs, 'ai-scheduler-card-muted');
			empty.createDiv({ text: 'No scheduled tasks yet.' });
			empty.createDiv({ text: 'Ask AI to plan a schedule from a plain-language goal.' }).addClass('ai-scheduler-empty-sub');
		}
		for (const job of scheduled) {
			const card = makeCard(jobs, 'ai-scheduler-task-card');
			const copy = card.createDiv();
			copy.createDiv({ text: `#${job.taskNumber} · ${job.title}` }).addClass('ai-scheduler-task-title');
			copy.createDiv({ text: `${describeBinding(job)} · ${describeSchedule(job)}${job.runCount ? ` · ${job.runCount} run${job.runCount === 1 ? '' : 's'}` : ''}` }).addClass('ai-scheduler-task-meta');
			const controls = card.createDiv('ai-scheduler-task-actions');
			makeButton(controls, 'Edit', () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
			makeButton(controls, 'Disable', async () => {
				job.enabled = false;
				job.nextRunAt = null;
				job.status = 'disabled';
				job.lastStatus = 'disabled';
				await this.plugin.saveState();
				this.render();
			}, false, true);
			makeButton(controls, 'Delete', async () => {
				if (!window.confirm(`Delete task #${job.taskNumber}? This cannot be undone.`)) return;
				await this.plugin.deleteJob(job);
				this.render();
			}, false, true);
		}

		const disabled = summarizeTasks(userJobs.filter(job => isDisabledTask(job))).slice(-8).reverse();
		if (disabled.length) {
			this.renderSection(shell, 'Disabled tasks', 'Paused and ready to enable');
			const disabledList = shell.createDiv();
			for (const job of disabled) {
				const card = makeCard(disabledList, 'ai-scheduler-task-card');
				const copy = card.createDiv();
				copy.createDiv({ text: `#${job.taskNumber} · ${job.title}` }).addClass('ai-scheduler-task-title');
				copy.createDiv({ text: `${describeBinding(job)} · ${describeSchedule(job)} · Disabled` }).addClass('ai-scheduler-task-meta');
				const controls = card.createDiv('ai-scheduler-task-actions');
				makeButton(controls, 'Edit', () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
				makeButton(controls, 'Enable', async () => {
					await this.plugin.enableJob(job);
					this.render();
				});
				makeButton(controls, 'Delete', async () => {
					if (!window.confirm(`Delete task #${job.taskNumber}? This cannot be undone.`)) return;
					await this.plugin.deleteJob(job);
					this.render();
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
				copy.createDiv({ text: `#${job.taskNumber} · ${job.title}` }).addClass('ai-scheduler-task-title');
				copy.createDiv({ text: `${describeBinding(job)} · ${job.lastStatus || job.status || 'completed'}${job.runCount ? ` · ${job.runCount} run${job.runCount === 1 ? '' : 's'}` : ''}${job.lastRunAt ? ` · Last run ${formatDate(job.lastRunAt)}` : ''}` }).addClass('ai-scheduler-task-meta');
				const controls = card.createDiv('ai-scheduler-task-actions');
				makeButton(controls, 'Edit', () => new JobModal(this.app, this.plugin, job, () => this.render()).open());
				makeButton(controls, 'Run again', async () => { await this.plugin.retryJob(job); this.render(); });
				makeButton(controls, 'Delete', async () => {
					if (!window.confirm(`Delete task #${job.taskNumber}? This cannot be undone.`)) return;
					await this.plugin.deleteJob(job);
					this.render();
				}, false, true);
			}
		}

		const activity = this.plugin.activity.slice(-8).reverse();
		const activityHeading = this.renderSection(shell, 'Recent activity', activity.length ? 'All times are local' : 'No activity yet');
		makeButton(activityHeading, 'Clear', async button => {
			button.disabled = true;
			await this.plugin.clearActivity();
			this.render();
		});
		const activityCard = makeCard(shell.createDiv(), 'ai-scheduler-activity');
		if (!activity.length) activityCard.createDiv({ text: 'Reviews, task runs, and notifications will appear here.' }).addClass('ai-scheduler-activity-empty');
		for (const event of activity) {
			const row = activityCard.createDiv('ai-scheduler-activity-row');
			row.createSpan({ text: event.message });
			row.createSpan({ text: formatDate(event.at) }).addClass('ai-scheduler-activity-time');
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
