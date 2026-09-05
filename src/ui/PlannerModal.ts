import { Modal, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { errorText } from '../util';
import { cronFormFor, describeSchedule, previewSchedule } from '../schedule';
import { createContextPicker } from './contextPicker';
import { makeButton, makeCard } from './dom';
import { AssistantModal } from './AssistantModal';
import { TaskSchedule } from '../types';

interface PlannedJobSummary {
	taskNumber: number;
	title: string;
	schedule: TaskSchedule;
}

export class PlannerModal extends Modal {
	plugin: AISchedulerPlugin;
	private planned: PlannedJobSummary[] | null = null;

	constructor(app: AISchedulerPlugin['app'], plugin: AISchedulerPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen(): Promise<void> {
		if (this.planned) this.renderResults();
		else await this.renderForm();
	}

	private async renderForm(): Promise<void> {
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-md');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv('ai-scheduler-shell ai-scheduler-shell-md');
		shell.createDiv('ai-scheduler-eyebrow').setText('AI PLANNER');
		shell.createEl('h1', { text: 'Plan scheduled work' }).addClass('ai-scheduler-title ai-scheduler-title-sm');
		shell.createEl('p', { text: 'Describe the outcome. Your selected backend will turn it into safe, persistent jobs.' }).addClass('ai-scheduler-subtitle');

		const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), [], this.app);
		shell.createDiv('ai-scheduler-form-label').setText('Default result folder for created tasks (optional)');
		const resultFolder = shell.createEl('input', { type: 'text', placeholder: 'Optional result folder for created tasks, e.g. Projects/News' });
		resultFolder.addClass('ai-scheduler-input');
		resultFolder.addClass('ai-scheduler-form-gap');
		const textarea = shell.createEl('textarea');
		textarea.addClass('ai-scheduler-textarea');
		textarea.addClass('ai-scheduler-textarea-tall');
		textarea.placeholder = 'Every evening, review the notes I changed today, identify open loops, and create a report in AI Reviews. Remind me every Monday to review unfinished work.';
		shell.createDiv('ai-scheduler-hint ai-scheduler-hint-gap').setText('Examples: review notes every evening, run every 30 minutes for 8 iterations, run every 2 hours until I stop it, remind me every Monday, or react when a project file changes.');
		const footer = shell.createDiv('ai-scheduler-footer');
		makeButton(footer, 'Cancel', () => this.close());
		makeButton(footer, 'Create AI plan', async button => {
			const goal = textarea.value.trim();
			if (!goal) { new Notice('Describe what you want AI Scheduler to do.'); return; }
			button.disabled = true;
			try {
				const result = await this.plugin.planAndCreate(goal, contextPicker.getPaths(), resultFolder.value.trim());
				new Notice(`AI created ${result.jobs.length} job(s)`, 6000);
				this.planned = result.jobs.map(job => ({ taskNumber: job.taskNumber, title: job.title, schedule: job.schedule }));
				await this.onOpen();
			} catch (error) {
				new Notice(`Planning failed: ${errorText(error)}`, 8000);
				button.disabled = false;
			}
		}, true);
	}

	/* After planning, show the created schedules in a table (cron form, plain
	 * English, and the next concrete run times) before moving on. */
	private renderResults(): void {
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-lg');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv('ai-scheduler-shell ai-scheduler-shell-lg');
		shell.createEl('h1', { text: 'Schedule created' }).addClass('ai-scheduler-title ai-scheduler-title-sm');
		shell.createEl('p', { text: 'Your tasks are scheduled. The cron form is shown for reference — the scheduler uses it behind the scenes.' }).addClass('ai-scheduler-subtitle');

		const table = shell.createEl('table');
		table.addClass('ai-scheduler-result-table');
		const head = table.createEl('tr');
		['Task', 'Cron form', 'Schedule', 'Next runs'].forEach(label => {
			head.createEl('th', { text: label });
		});
		for (const planned of this.planned || []) {
			const row = table.createEl('tr');
			const runs = previewSchedule(planned.schedule, 3);
			const cronForm = cronFormFor(planned.schedule);
			const titleCell = row.createEl('td');
			titleCell.setText(`#${planned.taskNumber} · ${planned.title}`);
			const cronCell = row.createEl('td');
			if (cronForm) cronCell.createEl('code', { text: cronForm });
			else cronCell.setText('—');
			row.createEl('td').setText(describeSchedule({ schedule: planned.schedule }));
			row.createEl('td').setText(runs.length ? runs.join(' · ') : 'on trigger');
		}

		const summary = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-gap');
		summary.createEl('div', { text: 'You can edit any task from the dashboard or its schedule note; the AI can also rewrite schedules in plain language.' }).addClass('ai-scheduler-hint');
		const footer = shell.createDiv('ai-scheduler-footer');
		makeButton(footer, 'Close', () => this.close());
		makeButton(footer, 'Open AI Scheduler', () => {
			this.close();
			new AssistantModal(this.app, this.plugin).open();
		}, true);
	}

	onClose(): void { this.contentEl.empty(); }
}
