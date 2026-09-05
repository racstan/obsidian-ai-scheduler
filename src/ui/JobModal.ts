import { Modal, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { errorText } from '../util';
import { SCHEDULE_KINDS, ScheduleKind, TaskSchedule } from '../types';
import { DAY_SHORT_NAMES, describeSchedule, formatMultiRules, getScheduleNextRun, parseMultiRulesText, previewSchedule, validClock } from '../schedule';
import { validateCron } from '../cron';
import { createContextPicker } from './contextPicker';
import { makeButton, makeCard } from './dom';

const KIND_LABELS: Record<ScheduleKind, string> = {
	once: 'Once at a specific time',
	daily: 'Every day',
	weekly: 'Weekly on selected days',
	multi: 'Multiple weekday/time rules',
	hourly: 'Every hour',
	interval: 'Every N minutes',
	event: 'When the vault changes',
	cron: 'Cron expression (advanced)',
};

interface EditorState {
	schedule: TaskSchedule;
	cooldownMinutes?: number;
}

export class JobModal extends Modal {
	plugin: AISchedulerPlugin;
	job: import('../types').Job;
	onSaved: () => void;
	private kind: ScheduleKind;
	private inputs: HTMLInputElement[] = [];
	private multiArea: HTMLTextAreaElement | null = null;
	private dayChecks: HTMLInputElement[] = [];
	private cronInput: HTMLInputElement | null = null;
	private kindSelect: HTMLSelectElement | null = null;

	constructor(app: AISchedulerPlugin['app'], plugin: AISchedulerPlugin, job: import('../types').Job, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.job = job;
		this.onSaved = onSaved;
		this.kind = job.schedule.kind;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-sm');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv('ai-scheduler-shell ai-scheduler-shell-tight');
		shell.createEl('h2', { text: 'Edit scheduled task' });
		shell.createEl('p', { text: 'Adjust the schedule directly, or describe a change in plain language and let AI rewrite it.' }).addClass('ai-scheduler-subtitle');

		const current = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-flush');
		current.createDiv({ text: this.job.title }).addClass('ai-scheduler-task-title');
		current.createDiv({ text: describeSchedule(this.job) }).addClass('ai-scheduler-task-meta');
		current.createDiv({ text: this.job.prompt }).addClass('ai-scheduler-task-prompt');

		this.renderScheduleEditor(shell);

		const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), this.job.contextPaths || [], this.app);
		shell.createDiv('ai-scheduler-form-label').setText('Result folder for this task (optional)');
		const resultFolder = shell.createEl('input', { type: 'text', value: this.job.output && this.job.output.folder || '', placeholder: 'Optional result folder, e.g. Projects/News' });
		resultFolder.addClass('ai-scheduler-input');
		resultFolder.addClass('ai-scheduler-form-gap');

		const footer = shell.createDiv('ai-scheduler-footer-wrap');
		makeButton(footer, 'Cancel', () => this.close());
		makeButton(footer, 'Save schedule changes', async () => {
			try {
				const state = this.readEditorState();
				const validation = this.validateState(state);
				if (validation) { new Notice(validation, 8000); return; }
				const folder = resultFolder.value.trim();
				const output = folder ? Object.assign({}, this.job.output || {}, { folder }) : null;
				await this.plugin.updateJob(this.job, { schedule: state.schedule, contextPaths: contextPicker.getPaths(), output, cooldownMinutes: state.cooldownMinutes });
				new Notice('Schedule updated and saved.', 6000);
				this.onSaved();
				this.close();
			} catch (error) {
				new Notice(`Could not update task: ${errorText(error)}`, 8000);
			}
		}, true);

		const aiSection = makeCard(shell, 'ai-scheduler-card-ai');
		aiSection.createDiv('ai-scheduler-lead ai-scheduler-gap-6').setText('Edit with AI (optional)');
		const request = aiSection.createEl('textarea', { placeholder: 'Example: Change this to run every 30 minutes for 8 iterations, and save each result in Projects/News.' });
		request.addClass('ai-scheduler-textarea');
		request.addClass('ai-scheduler-textarea-ai');
		makeButton(aiSection, 'Update task with AI', async button => {
			const change = request.value.trim();
			if (!change) { new Notice('Describe the task change first.'); return; }
			button.disabled = true;
			try {
				const contextPaths = contextPicker.getPaths();
				const plan = await this.plugin.refineJob(this.job, change, contextPaths);
				const schedule = plan.schedule || this.job.schedule;
				if (schedule.kind !== 'event' && !getScheduleNextRun(schedule, new Date(Date.now() - 1000))) throw new Error('AI returned an invalid schedule. Ask for a concrete time or cadence.');
				const folder = resultFolder.value.trim();
				const output = folder ? Object.assign({}, this.job.output || {}, { folder }) : null;
				await this.plugin.updateJob(this.job, { title: String(plan.title).trim(), prompt: String(plan.prompt).trim(), schedule, contextPaths, output });
				new Notice('AI updated and saved the scheduled task.', 6000);
				this.onSaved();
				this.close();
			} catch (error) { new Notice(`Could not update task: ${errorText(error)}`, 8000); button.disabled = false; }
		}, true);
	}

	/* Manual schedule editor: one dynamic field group per kind, with a live
	 * next-runs preview. Cron expressions are validated on every keystroke. */
	private renderScheduleEditor(shell: HTMLElement): void {
		const card = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-flush');
		card.createDiv('ai-scheduler-lead ai-scheduler-gap-8').setText('Schedule');

		const kindRow = card.createDiv('ai-scheduler-kind-row');
		this.kindSelect = kindRow.createEl('select');
		SCHEDULE_KINDS.forEach(option => {
			const element = this.kindSelect!.createEl('option', { value: option, text: KIND_LABELS[option] });
			element.selected = option === this.kind;
		});

		const fields = card.createDiv();
		const preview = card.createDiv('ai-scheduler-preview');

		const rerenderFields = () => {
			fields.empty();
			this.inputs = [];
			this.multiArea = null;
			this.dayChecks = [];
			this.cronInput = null;
			this.renderKindFields(fields, () => this.updatePreview(preview));
			this.updatePreview(preview);
		};
		this.kindSelect.onchange = () => {
			this.kind = this.kindSelect!.value as ScheduleKind;
			rerenderFields();
		};
		rerenderFields();
	}

	private updatePreview(preview: HTMLElement): void {
		preview.empty();
		const state = this.readEditorState();
		const schedule = state.schedule;
		if (schedule.kind === 'cron' && schedule.expression) {
			const error = validateCron(schedule.expression);
			if (error) {
				preview.createDiv({ text: error }).addClass('ai-scheduler-preview-error');
				return;
			}
		}
		if (schedule.kind === 'event') {
			preview.setText('Runs when the vault changes, after a cooldown.');
			return;
		}
		const runs = previewSchedule(schedule, 3);
		if (!runs.length) {
			preview.setText('No upcoming runs with the current values.');
			return;
		}
		preview.setText(`Next runs: ${runs.join('  ·  ')}`);
	}

	private renderKindFields(container: HTMLElement, onChange: () => void): void {
		const schedule = this.job.schedule;
		const input = (attributes: { type?: string; value?: string; min?: string; placeholder?: string; monospace?: boolean }): HTMLInputElement => {
			const element = container.createEl('input', { type: attributes.type || 'text' });
			if (attributes.value !== undefined) element.value = attributes.value;
			if (attributes.min !== undefined) element.min = attributes.min;
			if (attributes.placeholder !== undefined) element.placeholder = attributes.placeholder;
			element.addClass('ai-scheduler-input');
			if (attributes.monospace) element.addClass('ai-scheduler-input-mono');
			element.oninput = onChange;
			this.inputs.push(element);
			return element;
		};
		const label = (text: string) => container.createDiv('ai-scheduler-field-label').setText(text);

		switch (this.kind) {
			case 'once': {
				label('Date and time');
				const current = schedule.at ? new Date(schedule.at) : new Date(Date.now() + 60 * 60 * 1000);
				const pad = (value: number) => String(value).padStart(2, '0');
				input({
					type: 'datetime-local',
					value: `${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())}T${pad(current.getHours())}:${pad(current.getMinutes())}`,
				});
				break;
			}
			case 'daily': {
				label('Time (HH:MM)');
				input({ type: 'time', value: schedule.time || '09:00' });
				break;
			}
			case 'weekly': {
				label('Time (HH:MM)');
				input({ type: 'time', value: schedule.time || '09:00' });
				label('Days');
				const row = container.createDiv('ai-scheduler-days');
				DAY_SHORT_NAMES.forEach((day, index) => {
					const item = row.createEl('label');
					const checkbox = item.createEl('input', { type: 'checkbox' });
					checkbox.checked = Array.isArray(schedule.days) ? schedule.days.includes(index) : false;
					checkbox.onchange = onChange;
					item.createSpan({ text: day });
					this.dayChecks.push(checkbox);
				});
				break;
			}
			case 'multi': {
				label('Rules, one per line: days = HH:MM, HH:MM (e.g. Mon-Fri = 09:00)');
				const area = container.createEl('textarea', { text: formatMultiRules(schedule.rules) });
				area.addClass('ai-scheduler-textarea');
				area.addClass('ai-scheduler-textarea-short');
				area.oninput = onChange;
				this.multiArea = area;
				break;
			}
			case 'hourly': {
				label('Stop after this many runs (optional)');
				input({ type: 'number', value: schedule.maxIterations ? String(schedule.maxIterations) : '', min: '1', placeholder: 'unlimited' });
				break;
			}
			case 'interval': {
				label('Interval in minutes');
				input({ type: 'number', value: String(schedule.intervalMinutes || 30), min: '1' });
				label('Stop after this many runs (optional)');
				input({ type: 'number', value: schedule.maxIterations ? String(schedule.maxIterations) : '', min: '1', placeholder: 'unlimited' });
				break;
			}
			case 'event': {
				label('Vault event');
				const select = container.createEl('select');
				select.addClass('ai-scheduler-select');
				select.createEl('option', { value: 'modify', text: 'Any file is modified or created' });
				select.onchange = onChange;
				label('Cooldown minutes between runs');
				input({ type: 'number', value: String(this.job.cooldownMinutes ?? 10), min: '1' });
				break;
			}
			case 'cron': {
				label('5-field cron: minute, hour, day-of-month, month, day-of-week (0 = Sunday)');
				this.cronInput = input({
					type: 'text',
					value: schedule.expression || '',
					placeholder: '*/15 * * * *   or   0 9 * * 1-5',
					monospace: true,
				});
				container.createDiv('ai-scheduler-example').setText('Examples: */15 * * * * every 15 minutes · 0 9 * * 1-5 weekdays at 09:00 · 0 22 * * * daily at 22:00');
				break;
			}
		}
	}

	private readEditorState(): EditorState {
		const previous = this.job.schedule;
		const numbers = this.inputs
			.filter(input => input.type === 'number')
			.map(input => Number.parseInt(input.value, 10))
			.filter(value => Number.isFinite(value));
		const byKind = (): EditorState => {
			switch (this.kind) {
				case 'once': {
					const field = this.inputs.find(input => input.type === 'datetime-local');
					const date = field && field.value ? new Date(field.value) : null;
					return {
						schedule: {
							kind: 'once',
							at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : previous.at,
						},
					};
				}
				case 'daily': {
					const field = this.inputs.find(input => input.type === 'time');
					return { schedule: { kind: 'daily', time: field && field.value ? field.value : previous.time || '09:00' } };
				}
				case 'weekly': {
					const field = this.inputs.find(input => input.type === 'time');
					const days = this.dayChecks.map((checkbox, index) => checkbox.checked ? index : -1).filter(index => index >= 0);
					return { schedule: { kind: 'weekly', time: field && field.value ? field.value : previous.time || '09:00', days } };
				}
				case 'multi': {
					const rules = this.multiArea ? parseMultiRulesText(this.multiArea.value) : previous.rules || [];
					return { schedule: { kind: 'multi', rules } };
				}
				case 'hourly': {
					const max = numbers.length && numbers[0] > 0 ? numbers[0] : null;
					return { schedule: { kind: 'hourly', maxIterations: max } };
				}
				case 'interval': {
					const minutes = numbers.length && numbers[0] > 0 ? numbers[0] : Number(previous.intervalMinutes || 30);
					const max = numbers.length > 1 && numbers[1] > 0 ? numbers[1] : null;
					return { schedule: { kind: 'interval', intervalMinutes: minutes, maxIterations: max } };
				}
				case 'event': {
					return {
						schedule: { kind: 'event', event: 'modify' },
						cooldownMinutes: numbers.length && numbers[0] > 0 ? numbers[0] : this.job.cooldownMinutes ?? 10,
					};
				}
				case 'cron': {
					return { schedule: { kind: 'cron', expression: this.cronInput ? this.cronInput.value.trim() : previous.expression || '' } };
				}
			}
		};
		return byKind();
	}

	private validateState(state: EditorState): string | null {
		const schedule = state.schedule;
		if (schedule.kind === 'event') return null;
		if (schedule.kind === 'cron') {
			if (!schedule.expression) return 'Enter a cron expression, for example */15 * * * *';
			return validateCron(schedule.expression);
		}
		if (schedule.kind === 'once') {
			const time = schedule.at ? new Date(schedule.at).getTime() : NaN;
			if (Number.isNaN(time)) return 'Pick a valid date and time.';
			if (time <= Date.now()) return 'Pick a future date and time.';
			return null;
		}
		if (schedule.kind === 'daily' && !validClock(schedule.time)) return 'Enter a time as HH:MM.';
		if (schedule.kind === 'weekly' && (!validClock(schedule.time) || !(schedule.days || []).length)) return 'Choose at least one weekday and a valid time.';
		if (schedule.kind === 'multi' && !(schedule.rules || []).length) return 'Add at least one valid rule, e.g. Mon = 09:00.';
		if (schedule.kind === 'hourly' || schedule.kind === 'interval') {
			const minutes = schedule.kind === 'hourly' ? 60 : Number(schedule.intervalMinutes || 0);
			if (!(minutes > 0)) return 'Enter an interval greater than zero.';
		}
		if (!getScheduleNextRun(schedule, new Date(Date.now() - 1000))) {
			return 'The schedule has no valid upcoming time. Check the values.';
		}
		return null;
	}

	onClose(): void {
		this.contentEl.empty();
		this.inputs = [];
		this.multiArea = null;
		this.dayChecks = [];
		this.cronInput = null;
		this.kindSelect = null;
	}
}
