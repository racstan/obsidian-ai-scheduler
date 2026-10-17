/*
 * Highlights [[links]] inside a plain <textarea>. A textarea can't style part
 * of its text, so a backdrop element with the same classes (same padding,
 * font and border) is placed behind it and renders matching highlight boxes;
 * the textarea itself is transparent and stays fully editable.
 */
const LINK_PATTERN = /\[\[[^\]\n]+\]\]/g;

const WRAP_SPACING: [string, string][] = [
	['ai-scheduler-textarea-tall', 'ai-scheduler-highlight-wrap-tall'],
	['ai-scheduler-textarea-ai', 'ai-scheduler-highlight-wrap-gap'],
	['ai-scheduler-form-gap', 'ai-scheduler-highlight-wrap-gap'],
];

export function attachLinkHighlight(textarea: HTMLTextAreaElement): () => void {
	const parent = textarea.parentElement;
	if (!parent) return () => undefined;

	const wrap = createDiv({ cls: 'ai-scheduler-highlight-wrap' });
	// The textarea's margin moves to the wrapper (set here rather than with a
	// CSS :has() selector, which is slow to re-evaluate).
	for (const [textareaClass, wrapClass] of WRAP_SPACING) {
		if (textarea.hasClass(textareaClass)) wrap.addClass(wrapClass);
	}
	parent.insertBefore(wrap, textarea);
	const backdrop = wrap.createDiv({ cls: `${textarea.className} ai-scheduler-highlight-backdrop`, attr: { 'aria-hidden': 'true' } });
	wrap.appendChild(textarea);
	textarea.addClass('ai-scheduler-highlight-input');

	const render = () => {
		backdrop.empty();
		const text = textarea.value;
		let last = 0;
		for (const match of text.matchAll(LINK_PATTERN)) {
			const start = match.index ?? 0;
			if (start > last) backdrop.appendText(text.slice(last, start));
			backdrop.createSpan({ cls: 'ai-scheduler-link-mark', text: match[0] });
			last = start + match[0].length;
		}
		// The trailing space keeps a final empty line the same height as in the textarea.
		backdrop.appendText(`${text.slice(last)} `);
		backdrop.scrollTop = textarea.scrollTop;
	};
	const syncScroll = () => { backdrop.scrollTop = textarea.scrollTop; };

	textarea.addEventListener('input', render);
	textarea.addEventListener('scroll', syncScroll);
	render();

	return () => {
		textarea.removeEventListener('input', render);
		textarea.removeEventListener('scroll', syncScroll);
	};
}
