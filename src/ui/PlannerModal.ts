import { Modal, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { errorText } from '../util';
import { cronFormFor, describeSchedule, previewSchedule } from '../schedule';
import { createContextPicker } from './contextPicker';
import { makeButton, makeCard } from './dom';
import { AssistantModal } from './AssistantModal';
import { TaskSchedule } from '../types';
import { attachMentionSuggest } from './mentionSuggest';

interface PlannedJobSummary {
	taskNumber: number;
	title: string;
	schedule: TaskSchedule;
}

export class PlannerModal extends Modal {
	plugin: AISchedulerPlugin;
	private planned: PlannedJobSummary[] | null = null;
	private onCloseCallback?: () => void;

	constructor(app: AISchedulerPlugin['app'], plugin: AISchedulerPlugin, onCloseCallback?: () => void) {
		super(app);
		this.plugin = plugin;
		this.onCloseCallback = onCloseCallback;
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
		const shell = contentEl.createDiv({ cls: 'ai-scheduler-shell ai-scheduler-shell-md' });

		const navBar = shell.createDiv({ cls: 'ai-scheduler-modal-nav' });
		const backBtn = navBar.createEl('button', {
			cls: 'ai-scheduler-back-btn',
			text: '← Back to dashboard',
		});
		backBtn.onclick = () => {
			this.close();
			window.setTimeout(() => {
				new AssistantModal(this.app, this.plugin).open();
			}, 50);
		};

		shell.createDiv({ cls: 'ai-scheduler-eyebrow', text: 'AI Planner' });
		shell.createEl('h1', { text: 'Plan scheduled work', cls: 'ai-scheduler-title ai-scheduler-title-sm' });
		shell.createEl('p', { text: 'Describe your goal in plain english. Your active AI backend will design and configure the scheduled jobs.', cls: 'ai-scheduler-subtitle' });

		const readiness = this.plugin.getBackendReadiness();
		if (!readiness.ok) {
			const banner = shell.createDiv({ cls: 'ai-scheduler-alert-banner' });
			const content = banner.createDiv({ cls: 'ai-scheduler-alert-content' });
			content.createSpan({ cls: 'ai-scheduler-alert-icon', text: '⚠️' });
			const textCol = content.createDiv();
			textCol.createDiv({ cls: 'ai-scheduler-alert-title', text: 'AI backend not configured' });
			textCol.createDiv({ cls: 'ai-scheduler-alert-desc', text: readiness.message });
			const btn = banner.createEl('button', { text: 'Open settings', cls: 'mod-cta ai-scheduler-alert-btn' });
			btn.onclick = () => {
				this.close();
				window.setTimeout(() => {
					this.plugin.openSettingsTab();
				}, 50);
			};
		}

		shell.createDiv({ cls: 'ai-scheduler-form-label', text: 'What would you like AI Scheduler to do?' });
		const textarea = shell.createEl('textarea', { cls: 'ai-scheduler-textarea ai-scheduler-textarea-tall' });
		textarea.placeholder = 'E.g. Every weekday at 9:00 am, review notes modified in the last 24 hours, extract action items, and create an executive summary in AI Reviews (type @ to attach files)...';
		shell.createDiv({ cls: 'ai-scheduler-hint ai-scheduler-hint-gap', text: 'Tip: Type @ in the box above to quickly search and attach vault notes/files.' });

		shell.createDiv({ cls: 'ai-scheduler-form-label', text: 'Default result folder (optional)' });
		const resultFolder = shell.createEl('input', { type: 'text', cls: 'ai-scheduler-input ai-scheduler-form-gap', placeholder: 'Optional result folder, e.g. AI Reviews or Projects/Notes' });

		const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), [], this.app);

		attachMentionSuggest({
			textarea,
			app: this.app,
			onSelect: file => {
				contextPicker.addPath(file.path);
				new Notice(`Attached to context: ${file.path}`);
			},
		});

		const footer = shell.createDiv({ cls: 'ai-scheduler-footer' });
		makeButton(footer, 'Cancel', () => this.close());
		makeButton(footer, '✨ Create AI plan', async button => {
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
		const shell = contentEl.createDiv({ cls: 'ai-scheduler-shell ai-scheduler-shell-lg' });
		shell.createEl('h1', { text: 'Schedule created', cls: 'ai-scheduler-title ai-scheduler-title-sm' });
		shell.createEl('p', { text: 'Your tasks are scheduled. The cron form is shown for reference — the scheduler uses it behind the scenes.', cls: 'ai-scheduler-subtitle' });

		const table = shell.createEl('table', { cls: 'ai-scheduler-result-table' });
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
		summary.createDiv({ cls: 'ai-scheduler-hint', text: 'You can edit any task from the dashboard or its schedule note; the AI can also rewrite schedules in plain language.' });
		const footer = shell.createDiv({ cls: 'ai-scheduler-footer' });
		makeButton(footer, 'Close', () => this.close());
		makeButton(footer, 'Open AI Scheduler', () => {
			this.close();
			window.setTimeout(() => {
				new AssistantModal(this.app, this.plugin).open();
			}, 50);
		}, true);
	}

	onClose(): void {
		this.contentEl.empty();
		if (this.onCloseCallback && !this.planned) {
			window.setTimeout(() => {
				if (this.onCloseCallback) this.onCloseCallback();
			}, 50);
		}
	}
}
