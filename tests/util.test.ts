import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../src/util';

test('extractJson parses single and multiple <assistant-scheduler> blocks', () => {
	const single = '<assistant-scheduler>[{"title":"Task 1","prompt":"Prompt 1","schedule":{"kind":"daily","time":"09:00"}}]</assistant-scheduler>';
	const singleParsed = extractJson(single);
	assert.equal(singleParsed.length, 1);
	assert.equal(singleParsed[0].title, 'Task 1');

	const multiple = `
Here is part 1:
<assistant-scheduler>
[{"title":"Task A","prompt":"Prompt A","schedule":{"kind":"daily","time":"08:00"}}]
</assistant-scheduler>

And part 2:
<assistant-scheduler>
[{"title":"Task B","prompt":"Prompt B","schedule":{"kind":"weekly","time":"10:00","days":[1,3]}}]
</assistant-scheduler>
`;
	const multipleParsed = extractJson(multiple);
	assert.equal(multipleParsed.length, 2);
	assert.equal(multipleParsed[0].title, 'Task A');
	assert.equal(multipleParsed[1].title, 'Task B');
});

test('extractJson parses fenced json blocks and raw json strings', () => {
	const fenced = '```json\n[{"title":"Fenced","prompt":"p","schedule":{"kind":"once","at":"2026-10-01T09:00:00.000Z"}}]\n```';
	const fencedParsed = extractJson(fenced);
	assert.equal(fencedParsed.length, 1);
	assert.equal(fencedParsed[0].title, 'Fenced');

	const raw = '{"title":"Raw Object","prompt":"p","schedule":{"kind":"daily","time":"12:00"}}';
	const rawParsed = extractJson(raw);
	assert.equal(rawParsed.length, 1);
	assert.equal(rawParsed[0].title, 'Raw Object');
});
