/*
 * Type-ahead folder picker for text inputs, built on Obsidian's own
 * AbstractInputSuggest so the dropdown matches the user's theme. The user can
 * type any path or pick an existing folder (subfolders included).
 */
import { AbstractInputSuggest, App, TFolder } from 'obsidian';

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	private readonly vaultApp: App;
	private readonly input: HTMLInputElement;

	constructor(app: App, input: HTMLInputElement) {
		super(app, input);
		this.vaultApp = app;
		this.input = input;
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
		// Skip hidden folders (e.g. .obsidian); task output is never written there.
		const folders = this.vaultApp.vault.getAllFolders(false)
			.filter(folder => !folder.path.split('/').some(part => part.startsWith('.')));
		if (!q) return folders.sort((a, b) => a.path.localeCompare(b.path));
		const rank = (folder: TFolder): number => {
			const name = folder.name.toLowerCase();
			const path = folder.path.toLowerCase();
			if (name === q || path === q) return 0;
			if (name.startsWith(q)) return 1;
			if (path.startsWith(q)) return 2;
			return 3;
		};
		return folders
			.filter(folder => folder.path.toLowerCase().includes(q))
			.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.addClass('ai-scheduler-folder-suggestion');
		el.createDiv({ cls: 'ai-scheduler-folder-suggestion-name', text: folder.name });
		if (folder.parent && !folder.parent.isRoot()) {
			el.createDiv({ cls: 'ai-scheduler-folder-suggestion-path', text: folder.parent.path });
		}
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		// Let listeners (e.g. settings that save on input) see the new value.
		this.input.dispatchEvent(new Event('input', { bubbles: true }));
		this.close();
	}
}
