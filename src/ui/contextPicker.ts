/*
 * Modern Context & Attachments Picker
 * Displays attached files/folders as visual chips and provides fuzzy search modals for quick attachments.
 */
import { App, FuzzySuggestModal, Notice, TFile, TFolder } from 'obsidian';
import { makeButton, makeCard, makeClickable } from './dom';
import { ContextOption } from '../context';

export class FilePickerModal extends FuzzySuggestModal<TFile> {
	private onChosen: (file: TFile) => void;

	constructor(app: App, onChosen: (file: TFile) => void) {
		super(app);
		this.onChosen = onChosen;
		this.setPlaceholder('Type to search files or notes to attach...');
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter(f => !f.path.startsWith('.'));
	}

	getItemText(item: TFile): string {
		return item.path;
	}

	onChooseItem(item: TFile): void {
		this.onChosen(item);
	}
}

export class FolderPickerModal extends FuzzySuggestModal<TFolder> {
	private onChosen: (folder: TFolder) => void;

	constructor(app: App, onChosen: (folder: TFolder) => void) {
		super(app);
		this.onChosen = onChosen;
		this.setPlaceholder('Type to search vault folders to attach...');
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		const scan = (folder: TFolder) => {
			folders.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) scan(child);
			}
		};
		const root = this.app.vault.getRoot();
		if (root) scan(root);
		return folders.filter(f => f.path && f.path !== '/' && !f.path.startsWith('.'));
	}

	getItemText(item: TFolder): string {
		return `${item.path}/`;
	}

	onChooseItem(item: TFolder): void {
		this.onChosen(item);
	}
}

export interface ContextPickerInstance {
	getPaths: () => string[];
	addPath: (path: string) => void;
	removePath: (path: string) => void;
}

export function createContextPicker(
	parent: HTMLElement,
	options: ContextOption[],
	initialPaths: string[],
	app: App
): ContextPickerInstance {
	const card = makeCard(parent, 'ai-scheduler-card-flush');
	const header = card.createDiv({ cls: 'ai-scheduler-context-header' });
	header.createDiv({ cls: 'ai-scheduler-form-label', text: '📎 Context and attachments for this task' });
	header.createDiv({
		cls: 'ai-scheduler-hint',
		text: 'Attached notes and folders will be inspected and referenced by the AI when executing this task.',
	});

	const pathsSet = new Set<string>(initialPaths);
	const chipsContainer = card.createDiv({ cls: 'ai-scheduler-context-chips' });

	const renderChips = () => {
		chipsContainer.empty();
		if (pathsSet.size === 0) {
			chipsContainer.createDiv({
				cls: 'ai-scheduler-context-empty',
				text: 'No attachments yet. Type @ in the prompt above to mention notes, or use the attach buttons below.',
			});
			return;
		}

		pathsSet.forEach(path => {
			const isFolder = path.endsWith('/') || !path.includes('.');
			const chip = chipsContainer.createDiv({ cls: 'ai-scheduler-context-chip' });
			chip.createSpan({ cls: 'ai-scheduler-chip-icon', text: isFolder ? '📁' : '📄' });
			chip.createSpan({ cls: 'ai-scheduler-chip-text', text: path });
			const removeBtn = chip.createSpan({ cls: 'ai-scheduler-chip-remove', text: '✕' });
			removeBtn.setAttribute('title', 'Remove attachment');
			makeClickable(removeBtn, `Remove attachment ${path}`, (e) => {
				e.stopPropagation();
				pathsSet.delete(path);
				renderChips();
			});
		});
	};

	renderChips();

	const controls = card.createDiv({ cls: 'ai-scheduler-picker-controls' });

	makeButton(controls, 'Attach file...', () => {
		new FilePickerModal(app, file => {
			pathsSet.add(file.path);
			renderChips();
			new Notice(`Attached: ${file.path}`);
		}).open();
	});

	makeButton(controls, 'Attach active note', () => {
		const active = app.workspace.getActiveFile();
		if (!active) {
			new Notice('No active note is currently open in Obsidian.');
			return;
		}
		pathsSet.add(active.path);
		renderChips();
		new Notice(`Attached active note: ${active.path}`);
	});

	makeButton(controls, 'Attach folder...', () => {
		new FolderPickerModal(app, folder => {
			const normPath = `${folder.path}/`;
			pathsSet.add(normPath);
			renderChips();
			new Notice(`Attached folder: ${normPath}`);
		}).open();
	});

	makeButton(controls, 'Clear all', () => {
		pathsSet.clear();
		renderChips();
	});

	return {
		getPaths: () => Array.from(pathsSet),
		addPath: (path: string) => {
			pathsSet.add(path);
			renderChips();
		},
		removePath: (path: string) => {
			pathsSet.delete(path);
			renderChips();
		},
	};
}
