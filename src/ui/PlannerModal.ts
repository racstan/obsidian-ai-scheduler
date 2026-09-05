import { Modal, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { errorText } from '../util';
import { cronFormFor, describeSchedule, previewSchedule } from '../schedule';
import { createContextPicker } from './contextPicker';
import { makeButton, makeCard, styleElement } from './dom';
import { AssistantModal } from './AssistantModal';

interface PlannedJobSummary {
	taskNumber: number;
	title: string;
	schedule: import('../types').TaskSchedule;
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
		this.modalEl.style.width = 'min(700px, calc(100vw - 32px))';
		this.modalEl.style.padding = '0';
		contentEl.empty();
		styleElement(contentEl, { padding: '0', overflow: 'auto' });
		const shell = styleElement(contentEl.createEl('div'), { padding: '28px', maxWidth: '700px', margin: '0 auto' });
		styleElement(shell.createEl('div', { text: 'AI PLANNER' }), { color: 'var(--interactive-accent)', fontSize: '11px', fontWeight: '700', letterSpacing: '0.12em', marginBottom: '8px' });
		styleElement(shell.createEl('h1', { text: 'Plan scheduled work' }), { fontSize: '30px', margin: '0 0 8px', letterSpacing: '-0.03em' });
		styleElement(shell.createEl('p', { text: 'Describe the outcome. Your selected backend will turn it into safe, persistent jobs.' }), { margin: '0 0 22px', color: 'var(--text-muted)', lineHeight: '1.5' });

		const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), [], this.app);
		styleElement(shell.createEl('div', { text: 'Default result folder for created tasks (optional)' }), { color: 'var(--text-muted)', fontSize: '12px', marginBottom: '4px' });
		const resultFolder = shell.createEl('input', { type: 'text', placeholder: 'Optional result folder for created tasks, e.g. Projects/News' });
		styleElement(resultFolder, { width: '100%', boxSizing: 'border-box', marginBottom: '10px' });
		const textarea = shell.createEl('textarea');
		styleElement(textarea, { width: '100%', minHeight: '170px', resize: 'vertical', margin: '14px 0 8px', padding: '14px', borderRadius: '10px', border: '1px solid var(--background-modifier-border)', background: 'var(--background-primary-alt)', color: 'var(--text-normal)', fontFamily: 'inherit', lineHeight: '1.5', boxSizing: 'border-box' });
		textarea.placeholder = 'Every evening, review the notes I changed today, identify open loops, and create a report in AI Reviews. Remind me every Monday to review unfinished work.';
		styleElement(shell.createEl('div', { text: 'Examples: review notes every evening, run every 30 minutes for 8 iterations, run every 2 hours until I stop it, remind me every Monday, or react when a project file changes.' }), { color: 'var(--text-muted)', fontSize: '12px', marginBottom: '22px' });
		const footer = styleElement(shell.createEl('div'), { display: 'flex', justifyContent: 'flex-end', gap: '10px' });
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
		this.modalEl.style.width = 'min(760px, calc(100vw - 32px))';
		this.modalEl.style.padding = '0';
		contentEl.empty();
		styleElement(contentEl, { padding: '0', overflow: 'auto' });
		const shell = styleElement(contentEl.createEl('div'), { padding: '28px', maxWidth: '760px', margin: '0 auto' });
		styleElement(shell.createEl('h1', { text: 'Schedule created' }), { fontSize: '28px', margin: '0 0 8px', letterSpacing: '-0.03em' });
		styleElement(shell.createEl('p', { text: 'Your tasks are scheduled. The cron form is shown for reference — the scheduler uses it behind the scenes.' }), { margin: '0 0 18px', color: 'var(--text-muted)', lineHeight: '1.5' });

		const table = styleElement(shell.createEl('table'), { width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginBottom: '20px' });
		const head = table.createEl('tr');
		['Task', 'Cron form', 'Schedule', 'Next runs'].forEach(label => {
			styleElement(table.createEl('th', { text: label }), { textAlign: 'left', borderBottom: '2px solid var(--background-modifier-border)', padding: '8px 10px', whiteSpace: 'nowrap' });
		});
		void head;
		for (const planned of this.planned || []) {
			const row = table.createEl('tr');
			const runs = previewSchedule(planned.schedule, 3);
			const cronForm = cronFormFor(planned.schedule);
			const cells = [
				`#${planned.taskNumber} · ${planned.title}`,
				cronForm ?? '',
				describeSchedule({ schedule: planned.schedule }),
				runs.length ? runs.join(' · ') : 'on trigger',
			];
			cells.forEach((value, index) => {
				const cell = row.createEl('td');
				if (index === 1 && cronForm) {
					const code = cell.createEl('code', { text: cronForm });
					styleElement(code, { fontSize: '12px' });
				} else if (index === 0) {
					styleElement(cell, { fontWeight: '600' });
					cell.createEl('span', { text: value });
				} else {
					cell.createEl('span', { text: value });
				}
				styleElement(cell, { borderBottom: '1px solid var(--background-modifier-border)', padding: '10px', color: index === 0 ? 'var(--text-normal)' : 'var(--text-muted)', verticalAlign: 'top' });
			});
		}

		const summary = makeCard(shell, { padding: '12px 14px', marginBottom: '18px', color: 'var(--text-muted)', fontSize: '12px' });
		summary.createEl('div', { text: 'You can edit any task from the dashboard or its schedule note; the AI can also rewrite schedules in plain language.' });
		const footer = styleElement(shell.createEl('div'), { display: 'flex', justifyContent: 'flex-end', gap: '10px' });
		makeButton(footer, 'Close', () => this.close());
		makeButton(footer, 'Open AI Scheduler', () => {
			this.close();
			new AssistantModal(this.app, this.plugin).open();
		}, true);
	}

	onClose(): void { this.contentEl.empty(); }
}
