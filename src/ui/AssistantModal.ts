import { Modal } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { formatDate, describeBinding, isDisabledTask, isNightlyReviewJob, summarizeTasks } from '../util';
import { describeSchedule } from '../schedule';
import { makeButton, makeCard, styleElement } from './dom';
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
		this.modalEl.style.width = 'min(760px, calc(100vw - 32px))';
		this.modalEl.style.maxHeight = 'min(760px, calc(100vh - 32px))';
		this.modalEl.style.padding = '0';
		contentEl.empty();
		styleElement(contentEl, { padding: '0', overflow: 'auto' });
		const shell = styleElement(contentEl.createEl('div'), { padding: '28px', maxWidth: '760px', margin: '0 auto' });
		styleElement(shell.createEl('h1', { text: 'AI Scheduler' }), { fontSize: '32px', margin: '0 0 8px', letterSpacing: '-0.03em' });
		styleElement(shell.createEl('p', { text: 'Plan work, run reviews, and manage scheduled tasks from one place.' }), { margin: '0 0 24px', color: 'var(--text-muted)', maxWidth: '560px', lineHeight: '1.5' });

		const actions = styleElement(shell.createEl('div'), { display: 'flex', gap: '10px', flexWrap: 'wrap', paddingBottom: '24px', borderBottom: '1px solid var(--background-modifier-border)' });
		makeButton(actions, 'Ask AI to plan', () => new PlannerModal(this.app, this.plugin).open(), true);
		makeButton(actions, 'Run daily preview', () => this.plugin.startReviewRun(true, 'daily'));

		const userJobs = this.plugin.jobs.filter(job => !isNightlyReviewJob(job));
		const activeCount = userJobs.filter(job => job.enabled).length;
		const next = userJobs.filter(job => job.enabled && job.nextRunAt).sort((a, b) => new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime())[0];
		const stats = styleElement(shell.createEl('div'), { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', margin: '22px 0' });
		[[activeCount, 'ACTIVE TASKS'], [next ? formatDate(next.nextRunAt) : 'None', 'NEXT RUN'], [this.plugin.settings.nightlyReviewEnabled ? 'ON' : 'OFF', 'NIGHTLY REVIEW']].forEach(([value, label]) => {
			const stat = makeCard(stats, { padding: '13px 14px' });
			styleElement(stat.createEl('div', { text: String(value) }), { fontSize: '17px', fontWeight: '700' });
			styleElement(stat.createEl('div', { text: label as string }), { marginTop: '3px', fontSize: '10px', letterSpacing: '0.1em', color: 'var(--text-muted)' });
		});

		this.renderSection(shell, 'Scheduled tasks', `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'} enabled`);
		const bulkActions = styleElement(shell.createEl('div'), { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end', marginBottom: '10px' });
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
		const jobs = shell.createEl('div');
		if (!scheduled.length) {
			const empty = makeCard(jobs, { color: 'var(--text-muted)' });
			empty.createEl('div', { text: 'No scheduled tasks yet.' });
			styleElement(empty.createEl('div', { text: 'Ask AI to plan a schedule from a plain-language goal.' }), { marginTop: '6px', fontSize: '12px' });
		}
		for (const job of scheduled) {
			const card = makeCard(jobs, { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'center', marginBottom: '9px' });
			const copy = card.createEl('div');
			styleElement(copy.createEl('div', { text: `#${job.taskNumber} · ${job.title}` }), { fontWeight: '600' });
			styleElement(copy.createEl('div', { text: `${describeBinding(job)} · ${describeSchedule(job)}${job.runCount ? ` · ${job.runCount} run${job.runCount === 1 ? '' : 's'}` : ''}` }), { marginTop: '4px', color: 'var(--text-muted)', fontSize: '12px' });
			const controls = styleElement(card.createEl('div'), { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' });
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
			const disabledList = shell.createEl('div');
			for (const job of disabled) {
				const card = makeCard(disabledList, { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'center', marginBottom: '9px' });
				const copy = card.createEl('div');
				styleElement(copy.createEl('div', { text: `#${job.taskNumber} · ${job.title}` }), { fontWeight: '600' });
				styleElement(copy.createEl('div', { text: `${describeBinding(job)} · ${describeSchedule(job)} · Disabled` }), { marginTop: '4px', color: 'var(--text-muted)', fontSize: '12px' });
				const controls = styleElement(card.createEl('div'), { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' });
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
			const pastList = shell.createEl('div');
			for (const job of past) {
				const card = makeCard(pastList, { display: 'flex', justifyContent: 'space-between', gap: '14px', alignItems: 'center', marginBottom: '9px' });
				const copy = card.createEl('div');
				styleElement(copy.createEl('div', { text: `#${job.taskNumber} · ${job.title}` }), { fontWeight: '600' });
				styleElement(copy.createEl('div', { text: `${describeBinding(job)} · ${job.lastStatus || job.status || 'completed'}${job.runCount ? ` · ${job.runCount} run${job.runCount === 1 ? '' : 's'}` : ''}${job.lastRunAt ? ` · Last run ${formatDate(job.lastRunAt)}` : ''}` }), { marginTop: '4px', color: 'var(--text-muted)', fontSize: '12px' });
				const controls = styleElement(card.createEl('div'), { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' });
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
		const activityCard = makeCard(shell.createEl('div'), { padding: '6px 16px' });
		if (!activity.length) styleElement(activityCard.createEl('div', { text: 'Reviews, task runs, and notifications will appear here.' }), { padding: '10px 0', color: 'var(--text-muted)' });
		for (const event of activity) {
			const row = styleElement(activityCard.createEl('div'), { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--background-modifier-border)' });
			row.createEl('span', { text: event.message });
			styleElement(row.createEl('span', { text: formatDate(event.at) }), { color: 'var(--text-muted)', fontSize: '11px', whiteSpace: 'nowrap' });
		}
	}

	renderSection(parent: HTMLElement, title: string, description: string): HTMLDivElement {
		const heading = styleElement(parent.createEl('div'), { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '10px' });
		styleElement(heading.createEl('h2', { text: title }), { margin: '0', fontSize: '17px' });
		styleElement(heading.createEl('span', { text: description }), { color: 'var(--text-muted)', fontSize: '12px' });
		return heading;
	}

	onClose(): void { this.contentEl.empty(); }
}
