import { Modal, Notice } from 'obsidian';
import { AISchedulerPlugin } from '../main';
import { errorText } from '../util';
import { SCHEDULE_KINDS, ScheduleKind, TaskSchedule } from '../types';
import { DAY_SHORT_NAMES, MONTH_NAMES, formatMultiRules, getScheduleNextRun, normalizeMaxIterations, parseMultiRulesText, previewSchedule, validClock } from '../schedule';
import { validateCron } from '../cron';
import { createContextPicker } from './contextPicker';
import { closeExistingSchedulerModals, makeButton, makeCard } from './dom';
import { AssistantModal } from './AssistantModal';
import { attachMentionSuggest } from './mentionSuggest';

const KIND_LABELS: Record<ScheduleKind, string> = {
	once: 'Once at a specific time',
	daily: 'Daily / Every N days',
	weekly: 'Weekly / Every N weeks',
	monthly: 'Monthly / Every N months',
	yearly: 'Yearly / Every year',
	multi: 'Multiple weekday/time rules',
	hourly: 'Every hour',
	interval: 'Every N minutes / hours',
	event: 'When the vault changes',
	cron: 'Cron expression (advanced)',
};

interface EditorState {
	schedule: TaskSchedule;
	cooldownMinutes?: number;
}

interface ScheduleInputs {
	time?: HTMLInputElement;
	at?: HTMLInputElement;
	startAt?: HTMLInputElement;
	everyDays?: HTMLInputElement;
	everyWeeks?: HTMLInputElement;
	everyMonths?: HTMLInputElement;
	dayOfMonth?: HTMLInputElement;
	month?: HTMLSelectElement;
	intervalMinutes?: HTMLInputElement;
	maxIterations?: HTMLInputElement;
	cooldownMinutes?: HTMLInputElement;
	multiArea?: HTMLTextAreaElement;
	cronInput?: HTMLInputElement;
	dayChecks: HTMLInputElement[];
}

export class JobModal extends Modal {
	plugin: AISchedulerPlugin;
	job: import('../types').Job;
	onSaved: () => void;
	private editMode: 'manual' | 'ai' = 'manual';
	private kind: ScheduleKind;
	private scheduleInputs: ScheduleInputs = { dayChecks: [] };
	private kindSelect: HTMLSelectElement | null = null;

	constructor(app: AISchedulerPlugin['app'], plugin: AISchedulerPlugin, job: import('../types').Job, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.job = job;
		this.onSaved = onSaved;
		this.kind = job.schedule.kind;
	}

	onOpen(): void {
		closeExistingSchedulerModals(this);
		this.render();
	}

	render(): void {
		const { contentEl } = this;
		this.modalEl.addClass('ai-scheduler-modal');
		this.modalEl.addClass('ai-scheduler-modal-sm');
		contentEl.addClass('ai-scheduler-content');
		contentEl.empty();
		const shell = contentEl.createDiv({ cls: 'ai-scheduler-shell ai-scheduler-shell-tight' });

		const navBar = shell.createDiv({ cls: 'ai-scheduler-modal-nav' });
		const backBtn = navBar.createEl('button', {
			cls: 'ai-scheduler-back-btn',
			text: '← back to dashboard',
		});
		backBtn.onclick = () => {
			this.close();
			if (this.onSaved) {
				window.setTimeout(() => this.onSaved(), 50);
			} else {
				window.setTimeout(() => new AssistantModal(this.app, this.plugin).open(), 50);
			}
		};

		shell.createEl('h2', { text: `Edit Task #${this.job.taskNumber}` });
		shell.createEl('p', { text: 'Choose to edit the schedule and prompt manually, or ask AI to rewrite them for you.', cls: 'ai-scheduler-subtitle' });

		// Mode Switcher Tabs
		const switcher = shell.createDiv({ cls: 'ai-scheduler-tab-switcher' });
		const manualBtn = switcher.createEl('button', {
			cls: `ai-scheduler-tab-btn ${this.editMode === 'manual' ? 'is-active' : ''}`,
			text: 'Edit manually',
		});
		const aiBtn = switcher.createEl('button', {
			cls: `ai-scheduler-tab-btn ${this.editMode === 'ai' ? 'is-active' : ''}`,
			text: 'Edit with AI',
		});

		manualBtn.onclick = () => {
			if (this.editMode !== 'manual') {
				this.editMode = 'manual';
				this.render();
			}
		};
		aiBtn.onclick = () => {
			if (this.editMode !== 'ai') {
				this.editMode = 'ai';
				this.render();
			}
		};

		if (this.editMode === 'manual') {
			this.renderManualMode(shell);
		} else {
			this.renderAiMode(shell);
		}
	}

	private renderManualMode(shell: HTMLElement): void {
		if (this.job.doubt) {
			const doubtBanner = shell.createDiv({ cls: 'ai-scheduler-alert-banner ai-scheduler-gap-8' });
			const content = doubtBanner.createDiv({ cls: 'ai-scheduler-alert-content' });
			content.createSpan({ cls: 'ai-scheduler-alert-icon', text: '💡' });
			const textCol = content.createDiv();
			textCol.createDiv({ cls: 'ai-scheduler-alert-title', text: 'AI Planning Note & Unspecified Details' });
			textCol.createDiv({ cls: 'ai-scheduler-alert-desc', text: `${this.job.doubt} Default values were populated for any unspecified details. Please check the fields marked with * below.` });
		}

		const detailsCard = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-flush');
		const detailsHeader = detailsCard.createDiv({ cls: 'ai-scheduler-task-header ai-scheduler-gap-8' });
		detailsHeader.createDiv({ cls: 'ai-scheduler-lead', text: 'Task Details' });
		const idBadge = detailsHeader.createSpan({ cls: 'ai-scheduler-task-id-badge', text: `ID: ${this.job.id}` });
		idBadge.setAttribute('title', 'Click to copy task ID');
		idBadge.onclick = (e) => {
			e.stopPropagation();
			if (typeof navigator !== 'undefined' && navigator.clipboard) {
				void navigator.clipboard.writeText(this.job.id).then(() => {
					new Notice(`Copied Task ID: ${this.job.id}`);
				});
			}
		};

		const titleLabel = detailsCard.createDiv({ cls: 'ai-scheduler-form-label' });
		titleLabel.createSpan({ text: 'Task title' });
		titleLabel.createSpan({ cls: 'ai-scheduler-required-asterisk', text: ' *' });

		const titleInput = detailsCard.createEl('input', {
			type: 'text',
			placeholder: 'Task title...',
			cls: 'ai-scheduler-input ai-scheduler-form-gap',
		});
		titleInput.value = this.job.title || '';

		const promptLabel = detailsCard.createDiv({ cls: 'ai-scheduler-form-label' });
		promptLabel.createSpan({ text: 'Prompt & instructions' });
		promptLabel.createSpan({ cls: 'ai-scheduler-required-asterisk', text: ' *' });

		const promptInput = detailsCard.createEl('textarea', {
			placeholder: 'Instructions for the AI when executing this task (type @ to attach files)...',
			cls: 'ai-scheduler-textarea ai-scheduler-form-gap',
		});
		promptInput.value = this.job.prompt || '';
		attachMentionSuggest({
			textarea: promptInput,
			app: this.app,
			onSelect: file => {
				contextPicker.addPath(file.path);
				new Notice(`Attached to context: ${file.path}`);
			},
		});

		this.renderScheduleEditor(shell);

		const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), this.job.contextPaths || [], this.app);
		shell.createDiv({ cls: 'ai-scheduler-form-label', text: 'Result folder for this task (optional)' });
		const resultFolder = shell.createEl('input', {
			type: 'text',
			placeholder: 'Optional result folder, e.g. Projects/News',
			cls: 'ai-scheduler-input ai-scheduler-form-gap'
		});
		resultFolder.value = (this.job.output && this.job.output.folder) || '';

		const footer = shell.createDiv({ cls: 'ai-scheduler-footer-wrap' });
		makeButton(footer, 'Cancel', () => this.close());
		makeButton(footer, 'Save schedule changes', async () => {
			try {
				const state = this.readEditorState();
				const validation = this.validateState(state);
				if (validation) { new Notice(validation, 8000); return; }
				const folder = resultFolder.value.trim();
				const output = folder ? Object.assign({}, this.job.output || {}, { folder }) : null;
				const newTitle = titleInput.value.trim() || this.job.title;
				const newPrompt = promptInput.value.trim() || this.job.prompt;
				await this.plugin.updateJob(this.job, {
					title: newTitle,
					prompt: newPrompt,
					schedule: state.schedule,
					contextPaths: contextPicker.getPaths(),
					output,
					cooldownMinutes: state.cooldownMinutes,
				});
				new Notice('Schedule updated and saved.', 6000);
				this.onSaved();
				this.close();
			} catch (error) {
				new Notice(`Could not update task: ${errorText(error)}`, 8000);
			}
		}, true);
	}

	private renderAiMode(shell: HTMLElement): void {
		const aiSection = makeCard(shell, 'ai-scheduler-card-ai');
		aiSection.createDiv({ cls: 'ai-scheduler-lead ai-scheduler-gap-6', text: 'Describe what you want to change' });
		aiSection.createDiv({
			cls: 'ai-scheduler-hint ai-scheduler-gap-8',
			text: 'Example: "Change time to 1:50 PM every weekday", "Add daily summary notes folder", or "Rewrite instructions to check recent meetings".'
		});

		const readiness = this.plugin.getBackendReadiness();
		if (!readiness.ok) {
			const banner = aiSection.createDiv({ cls: 'ai-scheduler-alert-banner' });
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

		const request = aiSection.createEl('textarea', {
			placeholder: 'Describe your requested change (type @ to attach files)...',
			cls: 'ai-scheduler-textarea ai-scheduler-textarea-ai'
		});

		const contextPicker = createContextPicker(shell, this.plugin.getVaultContextOptions(), this.job.contextPaths || [], this.app);
		attachMentionSuggest({
			textarea: request,
			app: this.app,
			onSelect: file => {
				contextPicker.addPath(file.path);
				new Notice(`Attached to context: ${file.path}`);
			},
		});

		shell.createDiv({ cls: 'ai-scheduler-form-label', text: 'Result folder for this task (optional)' });
		const resultFolder = shell.createEl('input', {
			type: 'text',
			placeholder: 'Optional result folder, e.g. Projects/News',
			cls: 'ai-scheduler-input ai-scheduler-form-gap'
		});
		resultFolder.value = (this.job.output && this.job.output.folder) || '';

		const footer = shell.createDiv({ cls: 'ai-scheduler-footer-wrap' });
		makeButton(footer, 'Cancel', () => this.close());
		makeButton(footer, 'Update task with AI', async button => {
			const change = request.value.trim();
			if (!change) { new Notice('Describe the task change first.'); return; }
			button.disabled = true;
			button.setText('AI is updating...');
			try {
				const contextPaths = contextPicker.getPaths();
				const plan = await this.plugin.refineJob(this.job, change, contextPaths);
				const schedule = plan.schedule || this.job.schedule;
				if (schedule.kind !== 'event' && !getScheduleNextRun(schedule, new Date(Date.now() - 1000))) {
					throw new Error('AI returned an invalid schedule. Ask for a concrete time or cadence.');
				}
				const folder = resultFolder.value.trim();
				const output = folder ? Object.assign({}, this.job.output || {}, { folder }) : null;
				await this.plugin.updateJob(this.job, {
					title: String(plan.title).trim(),
					prompt: String(plan.prompt).trim(),
					schedule,
					contextPaths,
					output
				});
				new Notice('AI updated and saved the scheduled task.', 6000);
				this.onSaved();
				this.close();
			} catch (error) {
				new Notice(`Could not update task: ${errorText(error)}`, 8000);
				button.disabled = false;
				button.setText('Update task with AI');
			}
		}, true);
	}

	/* Manual schedule editor: one dynamic field group per kind, with a live
	 * next-runs preview. Cron expressions are validated on every keystroke. */
	private renderScheduleEditor(shell: HTMLElement): void {
		const card = makeCard(shell, 'ai-scheduler-card-tight', 'ai-scheduler-card-flush');
		card.createDiv({ cls: 'ai-scheduler-lead ai-scheduler-gap-8', text: 'Schedule' });

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
			this.scheduleInputs = { dayChecks: [] };
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
		const createLabel = (text: string, required = false): HTMLElement => {
			const label = container.createDiv('ai-scheduler-field-label');
			label.createSpan({ text });
			if (required) {
				label.createSpan({ cls: 'ai-scheduler-required-asterisk', text: ' *' });
			}
			return label;
		};

		const createInput = (attributes: { type?: string; value?: string; min?: string; max?: string; placeholder?: string; monospace?: boolean }): HTMLInputElement => {
			const element = container.createEl('input', { type: attributes.type || 'text' });
			if (attributes.value !== undefined) element.value = attributes.value;
			if (attributes.min !== undefined) element.min = attributes.min;
			if (attributes.max !== undefined) element.max = attributes.max;
			if (attributes.placeholder !== undefined) element.placeholder = attributes.placeholder;
			element.addClass('ai-scheduler-input');
			if (attributes.monospace) element.addClass('ai-scheduler-input-mono');
			element.oninput = onChange;
			return element;
		};

		switch (this.kind) {
			case 'once': {
				createLabel('Date and time', true);
				const current = schedule.at && new Date(schedule.at).getTime() > Date.now()
					? new Date(schedule.at)
					: new Date(Date.now() + 60 * 60 * 1000);
				const pad = (value: number) => String(value).padStart(2, '0');
				this.scheduleInputs.at = createInput({
					type: 'datetime-local',
					value: `${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())}T${pad(current.getHours())}:${pad(current.getMinutes())}`,
				});
				break;
			}
			case 'daily': {
				createLabel('Time (HH:MM)', true);
				this.scheduleInputs.time = createInput({ type: 'time', value: schedule.time || '09:00' });

				createLabel('Repeat cadence (every N days)');
				this.scheduleInputs.everyDays = createInput({
					type: 'number',
					value: String(schedule.everyDays || 1),
					min: '1',
					placeholder: '1 (daily)'
				});

				createLabel('Initial starting date (optional)');
				this.scheduleInputs.startAt = createInput({
					type: 'date',
					value: schedule.startAt ? schedule.startAt.slice(0, 10) : '',
					placeholder: 'YYYY-MM-DD'
				});

				createLabel('Stop after N runs (optional)');
				this.scheduleInputs.maxIterations = createInput({
					type: 'number',
					value: schedule.maxIterations ? String(schedule.maxIterations) : '',
					min: '1',
					placeholder: 'Run indefinitely'
				});
				break;
			}
			case 'weekly': {
				createLabel('Time (HH:MM)', true);
				this.scheduleInputs.time = createInput({ type: 'time', value: schedule.time || '09:00' });

				createLabel('Repeat cadence (every N weeks)');
				this.scheduleInputs.everyWeeks = createInput({
					type: 'number',
					value: String(schedule.everyWeeks || 1),
					min: '1',
					placeholder: '1 (every week)'
				});

				createLabel('Days of week', true);
				const row = container.createDiv('ai-scheduler-days');
				DAY_SHORT_NAMES.forEach((day, index) => {
					const item = row.createEl('label');
					const checkbox = item.createEl('input', { type: 'checkbox' });
					checkbox.checked = Array.isArray(schedule.days) ? schedule.days.includes(index) : false;
					checkbox.onchange = onChange;
					item.createSpan({ text: day });
					this.scheduleInputs.dayChecks.push(checkbox);
				});

				createLabel('Initial starting date (optional)');
				this.scheduleInputs.startAt = createInput({
					type: 'date',
					value: schedule.startAt ? schedule.startAt.slice(0, 10) : '',
					placeholder: 'YYYY-MM-DD'
				});

				createLabel('Stop after N runs (optional)');
				this.scheduleInputs.maxIterations = createInput({
					type: 'number',
					value: schedule.maxIterations ? String(schedule.maxIterations) : '',
					min: '1',
					placeholder: 'Run indefinitely'
				});
				break;
			}
			case 'monthly': {
				createLabel('Time (HH:MM)', true);
				this.scheduleInputs.time = createInput({ type: 'time', value: schedule.time || '09:00' });

				createLabel('Day of month (1-31)', true);
				this.scheduleInputs.dayOfMonth = createInput({
					type: 'number',
					value: String(schedule.dayOfMonth || 1),
					min: '1',
					max: '31',
					placeholder: '1'
				});

				createLabel('Repeat cadence (every N months)');
				this.scheduleInputs.everyMonths = createInput({
					type: 'number',
					value: String(schedule.everyMonths || 1),
					min: '1',
					placeholder: '1 (every month)'
				});

				createLabel('Initial starting date (optional)');
				this.scheduleInputs.startAt = createInput({
					type: 'date',
					value: schedule.startAt ? schedule.startAt.slice(0, 10) : '',
					placeholder: 'YYYY-MM-DD'
				});

				createLabel('Stop after N runs (optional)');
				this.scheduleInputs.maxIterations = createInput({
					type: 'number',
					value: schedule.maxIterations ? String(schedule.maxIterations) : '',
					min: '1',
					placeholder: 'Run indefinitely'
				});
				break;
			}
			case 'yearly': {
				createLabel('Time (HH:MM)', true);
				this.scheduleInputs.time = createInput({ type: 'time', value: schedule.time || '09:00' });

				createLabel('Month', true);
				const monthSelect = container.createEl('select');
				monthSelect.addClass('ai-scheduler-select');
				for (let m = 1; m <= 12; m++) {
					const opt = monthSelect.createEl('option', { value: String(m), text: MONTH_NAMES[m] });
					opt.selected = m === (schedule.month || 1);
				}
				monthSelect.onchange = onChange;
				this.scheduleInputs.month = monthSelect;

				createLabel('Day of month (1-31)', true);
				this.scheduleInputs.dayOfMonth = createInput({
					type: 'number',
					value: String(schedule.dayOfMonth || 1),
					min: '1',
					max: '31',
					placeholder: '1'
				});

				createLabel('Stop after N runs (optional)');
				this.scheduleInputs.maxIterations = createInput({
					type: 'number',
					value: schedule.maxIterations ? String(schedule.maxIterations) : '',
					min: '1',
					placeholder: 'Run indefinitely'
				});
				break;
			}
			case 'hourly': {
				createLabel('Initial starting time (HH:MM, optional)');
				this.scheduleInputs.time = createInput({
					type: 'time',
					value: schedule.time || '',
					placeholder: '09:00'
				});

				createLabel('Stop after N runs (optional)');
				this.scheduleInputs.maxIterations = createInput({
					type: 'number',
					value: schedule.maxIterations ? String(schedule.maxIterations) : '',
					min: '1',
					placeholder: 'Run indefinitely'
				});
				break;
			}
			case 'interval': {
				createLabel('Interval in minutes', true);
				this.scheduleInputs.intervalMinutes = createInput({
					type: 'number',
					value: String(schedule.intervalMinutes || 30),
					min: '1',
					placeholder: '30'
				});

				createLabel('Initial starting time (HH:MM, optional)');
				this.scheduleInputs.time = createInput({
					type: 'time',
					value: schedule.time || '',
					placeholder: '09:00'
				});

				createLabel('Initial starting date (optional)');
				this.scheduleInputs.startAt = createInput({
					type: 'date',
					value: schedule.startAt ? schedule.startAt.slice(0, 10) : '',
					placeholder: 'YYYY-MM-DD'
				});

				createLabel('Stop after N runs (optional)');
				this.scheduleInputs.maxIterations = createInput({
					type: 'number',
					value: schedule.maxIterations ? String(schedule.maxIterations) : '',
					min: '1',
					placeholder: 'Run indefinitely'
				});
				break;
			}
			case 'multi': {
				createLabel('Rules, one per line: days = HH:MM, HH:MM (e.g. Mon-Fri = 09:00)', true);
				const area = container.createEl('textarea', { text: formatMultiRules(schedule.rules) });
				area.addClass('ai-scheduler-textarea');
				area.addClass('ai-scheduler-textarea-short');
				area.oninput = onChange;
				this.scheduleInputs.multiArea = area;

				createLabel('Stop after N runs (optional)');
				this.scheduleInputs.maxIterations = createInput({
					type: 'number',
					value: schedule.maxIterations ? String(schedule.maxIterations) : '',
					min: '1',
					placeholder: 'Run indefinitely'
				});
				break;
			}
			case 'event': {
				createLabel('Vault event', true);
				const select = container.createEl('select');
				select.addClass('ai-scheduler-select');
				select.createEl('option', { value: 'modify', text: 'Any file is modified or created' });
				select.onchange = onChange;

				createLabel('Cooldown minutes between runs', true);
				this.scheduleInputs.cooldownMinutes = createInput({
					type: 'number',
					value: String(this.job.cooldownMinutes ?? 10),
					min: '1'
				});

				createLabel('Stop after N runs (optional)');
				this.scheduleInputs.maxIterations = createInput({
					type: 'number',
					value: schedule.maxIterations ? String(schedule.maxIterations) : '',
					min: '1',
					placeholder: 'Run indefinitely'
				});
				break;
			}
			case 'cron': {
				createLabel('5-field cron: minute, hour, day-of-month, month, day-of-week (0 = Sunday)', true);
				this.scheduleInputs.cronInput = createInput({
					type: 'text',
					value: schedule.expression || '',
					placeholder: '*/15 * * * *   or   0 9 * * 1-5',
					monospace: true,
				});
				container.createDiv('ai-scheduler-example').setText('Examples: */15 * * * * every 15 minutes · 0 9 * * 1-5 weekdays at 09:00 · 0 22 * * * daily at 22:00');

				createLabel('Stop after N runs (optional)');
				this.scheduleInputs.maxIterations = createInput({
					type: 'number',
					value: schedule.maxIterations ? String(schedule.maxIterations) : '',
					min: '1',
					placeholder: 'Run indefinitely'
				});
				break;
			}
		}
	}

	private readEditorState(): EditorState {
		const previous = this.job.schedule;
		const s = this.scheduleInputs;

		const maxIterations = s.maxIterations && s.maxIterations.value.trim()
			? normalizeMaxIterations(s.maxIterations.value)
			: null;

		const startAtDate = s.startAt && s.startAt.value.trim()
			? s.startAt.value.trim()
			: undefined;

		switch (this.kind) {
			case 'once': {
				const date = s.at && s.at.value ? new Date(s.at.value) : null;
				return {
					schedule: {
						kind: 'once',
						at: date && !Number.isNaN(date.getTime()) ? date.toISOString() : previous.at,
					},
				};
			}
			case 'daily': {
				const time = s.time && s.time.value ? s.time.value : previous.time || '09:00';
				const everyDays = s.everyDays && Number(s.everyDays.value) > 0 ? Number(s.everyDays.value) : 1;
				return {
					schedule: {
						kind: 'daily',
						time,
						everyDays,
						startAt: startAtDate,
						maxIterations,
					},
				};
			}
			case 'weekly': {
				const time = s.time && s.time.value ? s.time.value : previous.time || '09:00';
				const everyWeeks = s.everyWeeks && Number(s.everyWeeks.value) > 0 ? Number(s.everyWeeks.value) : 1;
				const days = s.dayChecks.map((checkbox, index) => checkbox.checked ? index : -1).filter(index => index >= 0);
				return {
					schedule: {
						kind: 'weekly',
						time,
						days,
						everyWeeks,
						startAt: startAtDate,
						maxIterations,
					},
				};
			}
			case 'monthly': {
				const time = s.time && s.time.value ? s.time.value : previous.time || '09:00';
				const dayOfMonth = s.dayOfMonth && Number(s.dayOfMonth.value) >= 1 && Number(s.dayOfMonth.value) <= 31 ? Number(s.dayOfMonth.value) : 1;
				const everyMonths = s.everyMonths && Number(s.everyMonths.value) > 0 ? Number(s.everyMonths.value) : 1;
				return {
					schedule: {
						kind: 'monthly',
						time,
						dayOfMonth,
						everyMonths,
						startAt: startAtDate,
						maxIterations,
					},
				};
			}
			case 'yearly': {
				const time = s.time && s.time.value ? s.time.value : previous.time || '09:00';
				const month = s.month && Number(s.month.value) >= 1 && Number(s.month.value) <= 12 ? Number(s.month.value) : 1;
				const dayOfMonth = s.dayOfMonth && Number(s.dayOfMonth.value) >= 1 && Number(s.dayOfMonth.value) <= 31 ? Number(s.dayOfMonth.value) : 1;
				return {
					schedule: {
						kind: 'yearly',
						time,
						month,
						dayOfMonth,
						maxIterations,
					},
				};
			}
			case 'multi': {
				const rules = s.multiArea ? parseMultiRulesText(s.multiArea.value) : previous.rules || [];
				return {
					schedule: {
						kind: 'multi',
						rules,
						maxIterations,
					},
				};
			}
			case 'hourly': {
				const time = s.time && s.time.value ? s.time.value : undefined;
				return {
					schedule: {
						kind: 'hourly',
						time,
						maxIterations,
					},
				};
			}
			case 'interval': {
				const minutes = s.intervalMinutes && Number(s.intervalMinutes.value) > 0 ? Number(s.intervalMinutes.value) : Number(previous.intervalMinutes || 30);
				const time = s.time && s.time.value ? s.time.value : undefined;
				return {
					schedule: {
						kind: 'interval',
						intervalMinutes: minutes,
						time,
						startAt: startAtDate,
						maxIterations,
					},
				};
			}
			case 'event': {
				const cooldown = s.cooldownMinutes && Number(s.cooldownMinutes.value) > 0 ? Number(s.cooldownMinutes.value) : this.job.cooldownMinutes ?? 10;
				return {
					schedule: {
						kind: 'event',
						event: 'modify',
						maxIterations,
					},
					cooldownMinutes: cooldown,
				};
			}
			case 'cron': {
				return {
					schedule: {
						kind: 'cron',
						expression: s.cronInput ? s.cronInput.value.trim() : previous.expression || '',
						maxIterations,
					},
				};
			}
		}
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
		if (schedule.kind === 'monthly' && (!validClock(schedule.time) || !schedule.dayOfMonth || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) return 'Enter a valid day of month (1-31) and time.';
		if (schedule.kind === 'yearly' && (!validClock(schedule.time) || !schedule.month || !schedule.dayOfMonth || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 31)) return 'Enter a valid month, day of month, and time.';
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
		this.scheduleInputs = { dayChecks: [] };
		this.kindSelect = null;
	}
}

