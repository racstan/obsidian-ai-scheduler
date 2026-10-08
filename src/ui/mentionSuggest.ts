/*
 * Autocomplete / @mention suggestion handler for prompt textareas.
 * Enables users to type "@" to search and attach vault notes, files and folders.
 */
import { App, TAbstractFile, TFile, TFolder } from 'obsidian';

export interface MentionSuggestOptions {
	textarea: HTMLTextAreaElement;
	app: App;
	onSelect?: (item: TAbstractFile) => void;
}

export function attachMentionSuggest(options: MentionSuggestOptions): () => void {
	const { textarea, app, onSelect } = options;
	let popup: HTMLElement | null = null;
	let selectedIndex = 0;
	let matches: TAbstractFile[] = [];
	let queryStartIndex = -1;

	const removePopup = () => {
		if (popup) {
			popup.remove();
			popup = null;
		}
		textarea.setAttribute('aria-expanded', 'false');
		textarea.removeAttribute('aria-activedescendant');
		matches = [];
		selectedIndex = 0;
		queryStartIndex = -1;
	};

	const nameOf = (item: TAbstractFile) => item instanceof TFile ? item.basename : item.name;

	const getVaultItems = (query: string): TAbstractFile[] => {
		const q = query.toLowerCase().trim();
		// Files and folders (not the vault root), skipping hidden paths such as .obsidian.
		const all = app.vault.getAllLoadedFiles().filter(f =>
			(f instanceof TFile || (f instanceof TFolder && !f.isRoot()))
			&& !f.path.split('/').some(part => part.startsWith('.')));
		if (!q) {
			return all.slice(0, 10);
		}
		const filtered = all.filter(f =>
			nameOf(f).toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
		);
		filtered.sort((a, b) => {
			const aBase = nameOf(a).toLowerCase();
			const bBase = nameOf(b).toLowerCase();
			if (aBase === q) return -1;
			if (bBase === q) return 1;
			if (aBase.startsWith(q) && !bBase.startsWith(q)) return -1;
			if (!aBase.startsWith(q) && bBase.startsWith(q)) return 1;
			return a.path.localeCompare(b.path);
		});
		return filtered.slice(0, 10);
	};

	const insertSelection = (item: TAbstractFile) => {
		if (queryStartIndex < 0) return;
		const text = textarea.value;
		const cursor = textarea.selectionStart;
		const before = text.slice(0, queryStartIndex);
		const after = text.slice(cursor);
		// Files: shortest unambiguous link text, so duplicate basenames resolve correctly.
		// Folders can't be wikilinked, so they're shown as [[path/]]; the folder itself
		// is passed to the AI through the attached context.
		const mentionText = item instanceof TFile
			? `[[${app.metadataCache.fileToLinktext(item, '')}]]`
			: `[[${item.path}/]]`;
		textarea.value = `${before}${mentionText} ${after}`;
		const nextCursor = before.length + mentionText.length + 1;
		textarea.setSelectionRange(nextCursor, nextCursor);
		textarea.focus();
		removePopup();
		// Programmatic edits don't fire 'input'; listeners such as link highlighting need it.
		textarea.dispatchEvent(new Event('input', { bubbles: true }));
		if (onSelect) {
			onSelect(item);
		}
	};

	const renderPopup = () => {
		if (!matches.length) {
			removePopup();
			return;
		}
		if (!popup) {
			const parent = textarea.parentElement || document.body;
			if (window.getComputedStyle(parent).position === 'static') {
				parent.addClass('ai-scheduler-mention-container');
			}
			popup = parent.createDiv({ cls: 'ai-scheduler-mention-popup' });
		}
		const popupId = 'ai-scheduler-mention-list';
		popup.empty();

		const header = popup.createDiv({ cls: 'ai-scheduler-mention-header' });
		header.createSpan({ text: 'Notes, files and folders (press Enter to attach)' });

		const list = popup.createDiv({ cls: 'ai-scheduler-mention-list', attr: { id: popupId, role: 'listbox', 'aria-label': 'Notes, files and folders' } });
		matches.forEach((item, index) => {
			const isSelected = index === selectedIndex;
			const row = list.createDiv({
				cls: `ai-scheduler-mention-item ${isSelected ? 'is-selected' : ''}`,
				attr: { id: `${popupId}-${index}`, role: 'option', 'aria-selected': String(isSelected) },
			});
			row.createSpan({ cls: 'ai-scheduler-mention-icon', text: item instanceof TFolder ? '📁' : '📄' });
			const info = row.createDiv({ cls: 'ai-scheduler-mention-info' });
			info.createDiv({ cls: 'ai-scheduler-mention-name', text: nameOf(item) });
			if (item.parent && item.parent.path && item.parent.path !== '/') {
				info.createDiv({ cls: 'ai-scheduler-mention-path', text: item.parent.path });
			}

			row.addEventListener('mousedown', (e) => {
				e.preventDefault();
				insertSelection(item);
			});
		});

		textarea.setAttribute('aria-controls', popupId);
		textarea.setAttribute('aria-expanded', 'true');
		textarea.setAttribute('aria-activedescendant', `${popupId}-${selectedIndex}`);

		// Scroll selected item into view
		const selectedEl = list.children[selectedIndex] as HTMLElement;
		if (selectedEl) {
			selectedEl.scrollIntoView({ block: 'nearest' });
		}
	};

	const onInput = () => {
		const cursor = textarea.selectionStart;
		const text = textarea.value.slice(0, cursor);
		const atMatch = text.match(/@([^\s@]*)$/);
		if (atMatch && atMatch.index !== undefined) {
			queryStartIndex = atMatch.index;
			const query = atMatch[1];
			matches = getVaultItems(query);
			selectedIndex = 0;
			renderPopup();
		} else {
			removePopup();
		}
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (!popup || !matches.length) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % matches.length;
			renderPopup();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
			renderPopup();
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			if (matches[selectedIndex]) {
				e.preventDefault();
				insertSelection(matches[selectedIndex]);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			removePopup();
		}
	};

	let blurTimer: number | null = null;
	const onBlur = () => {
		if (blurTimer !== null) window.clearTimeout(blurTimer);
		blurTimer = window.setTimeout(() => {
			blurTimer = null;
			// The popup may already be gone (selection made, or modal closed).
			if (popup) removePopup();
		}, 200);
	};

	textarea.addEventListener('input', onInput);
	textarea.addEventListener('keydown', onKeyDown);
	textarea.addEventListener('blur', onBlur);

	return () => {
		if (blurTimer !== null) {
			window.clearTimeout(blurTimer);
			blurTimer = null;
		}
		textarea.removeEventListener('input', onInput);
		textarea.removeEventListener('keydown', onKeyDown);
		textarea.removeEventListener('blur', onBlur);
		removePopup();
	};
}
