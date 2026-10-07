export function makeButton(parent: HTMLElement, label: string, onClick: (button: HTMLButtonElement) => void | Promise<void>, primary = false, danger = false): HTMLButtonElement {
	const button = parent.createEl('button', { text: label });
	if (primary) button.addClass('mod-cta');
	if (danger) button.addClass('ai-scheduler-button-danger');
	button.onclick = () => { void onClick(button); };
	return button;
}

export function makeCard(parent: HTMLElement, ...extraClasses: string[]): HTMLDivElement {
	const card = parent.createDiv();
	card.addClass('ai-scheduler-card');
	for (const extra of extraClasses) card.addClass(extra);
	return card;
}

/**
 * Returns a refresh function for modals that rebuild their DOM on a timer.
 * It re-renders only when `signature()` changes, never while the user is using
 * a form control inside the modal, and keeps the scroll position of every
 * scrolled element so lists don't jump back to the top.
 */
export function liveRefresh(root: HTMLElement, signature: () => string, render: () => void): () => void {
	let last = signature();
	return () => {
		const next = signature();
		if (next === last) return;
		const active = root.ownerDocument.activeElement;
		if (active && root.contains(active) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
		const scrolled: Array<{ key: string; index: number; top: number }> = [];
		const keyOf = (el: Element) => el === root ? ':root' : el.className;
		[root, ...Array.from(root.querySelectorAll('*'))].forEach(el => {
			if (el.scrollTop > 0) {
				const key = keyOf(el);
				const index = el === root ? 0 : Array.from(root.getElementsByClassName(el.className)).indexOf(el);
				scrolled.push({ key, index, top: el.scrollTop });
			}
		});
		last = next;
		render();
		for (const { key, index, top } of scrolled) {
			const el = key === ':root' ? root : (key ? root.getElementsByClassName(key)[index] : undefined);
			if (el) el.scrollTop = top;
		}
	};
}

export function closeExistingSchedulerModals(currentModal?: { modalEl?: HTMLElement; contentEl?: HTMLElement }): void {
	if (typeof document === 'undefined') return;
	document.querySelectorAll('.ai-scheduler-modal').forEach(el => {
		if (currentModal && currentModal.modalEl && (el === currentModal.modalEl || el.contains(currentModal.modalEl))) {
			return;
		}
		const container = el.closest('.modal-container');
		if (container && currentModal && currentModal.contentEl && container.contains(currentModal.contentEl)) {
			return;
		}
		if (container) {
			const closeBtn = container.querySelector('.modal-close-button') as HTMLElement;
			if (closeBtn) closeBtn.click();
			else container.remove();
		}
	});
}

