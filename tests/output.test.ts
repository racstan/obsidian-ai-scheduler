import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendBlock, dailyNotePath, insertBlock, outputMode } from '../src/output';

const block = appendBlock('Summary', '2026-10-17 09:00', 'Result text\n\n');

test('outputMode keeps the old meaning for tasks saved before modes', () => {
	assert.equal(outputMode(null), 'new');
	assert.equal(outputMode({ folder: 'Reports' }), 'new');
	assert.equal(outputMode({ folder: 'Reports', filename: 'Weekly' }), 'replace');
	assert.equal(outputMode({ filename: 'Weekly', mode: 'append' }), 'append');
	assert.equal(outputMode({ mode: 'bogus' as never, filename: 'x' }), 'replace');
});

test('appendBlock labels the run and trims the reply', () => {
	assert.equal(block, '**Summary** · 2026-10-17 09:00\n\nResult text\n');
});

test('insertBlock adds to the end of a note, or starts an empty one', () => {
	assert.equal(insertBlock('', block), block);
	assert.equal(insertBlock('# Log\n\nOld entry\n\n\n', block), `# Log\n\nOld entry\n\n${block}`);
});

test('insertBlock adds to the end of the section under the heading', () => {
	const note = '# Day\n\n## AI\n\nFirst\n\n## Tasks\n\n- [ ] thing\n';
	assert.equal(
		insertBlock(note, block, 'AI'),
		'# Day\n\n## AI\n\nFirst\n\n**Summary** · 2026-10-17 09:00\n\nResult text\n\n## Tasks\n\n- [ ] thing\n',
	);
});

test('insertBlock matches the heading at any level, with or without #, ignoring case', () => {
	const note = '# Day\n### ai notes\nx\n# Next';
	const result = insertBlock(note, block, '## AI Notes');
	assert.ok(result.indexOf('Result text') < result.indexOf('# Next'));
	assert.ok(result.indexOf('Result text') > result.indexOf('### ai notes'));
});

test('insertBlock keeps deeper subsections inside the section', () => {
	const note = '## AI\nintro\n### Detail\nmore\n## Other';
	const result = insertBlock(note, block, 'AI');
	assert.ok(result.indexOf('Result text') > result.indexOf('more'));
	assert.ok(result.indexOf('Result text') < result.indexOf('## Other'));
});

test('insertBlock creates a missing heading at the end', () => {
	assert.equal(insertBlock('Some text', block, 'AI'), `Some text\n\n## AI\n\n${block}`);
	assert.equal(insertBlock('', block, 'AI'), `## AI\n\n${block}`);
});

test('insertBlock ignores headings inside code blocks', () => {
	const note = '```\n## AI\n```\n\n## AI\n\nreal';
	const result = insertBlock(note, block, 'AI');
	assert.ok(result.indexOf('Result text') > result.indexOf('real'));
});

test('dailyNotePath follows the Daily notes folder and format', () => {
	const format = (date: Date, pattern: string) => pattern
		.replace(/YYYY/g, String(date.getFullYear()))
		.replace(/MM/g, String(date.getMonth() + 1).padStart(2, '0'))
		.replace(/DD/g, String(date.getDate()).padStart(2, '0'));
	const date = new Date(2026, 9, 17);
	assert.equal(dailyNotePath({}, date, format), '2026-10-17.md');
	assert.equal(dailyNotePath({ folder: '/Journal/Daily/', format: 'DD-MM-YYYY' }, date, format), 'Journal/Daily/17-10-2026.md');
	assert.equal(dailyNotePath({ format: 'YYYY/MM/YYYY-MM-DD' }, date, format), '2026/10/2026-10-17.md');
});
