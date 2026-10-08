import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANGELOG_DATA, compareVersions, getReleasesSince } from '../src/changelog';
import manifest from '../manifest.json';

test('the embedded changelog has an entry for the current manifest version', () => {
	assert.equal(CHANGELOG_DATA[0].version, manifest.version, 'add a src/changelog.ts (and CHANGELOG.md) entry for this release');
});

test('changelog entries are newest first', () => {
	for (let i = 1; i < CHANGELOG_DATA.length; i++) {
		assert.ok(compareVersions(CHANGELOG_DATA[i - 1].version, CHANGELOG_DATA[i].version) > 0, `${CHANGELOG_DATA[i - 1].version} before ${CHANGELOG_DATA[i].version}`);
	}
});

test('getReleasesSince shows every newer release for an unknown previous version', () => {
	const since = getReleasesSince('2.1.7.17.5');
	assert.deepEqual(since.map(r => r.version), CHANGELOG_DATA.filter(r => compareVersions(r.version, '2.1.7.17.5') > 0).map(r => r.version));
	assert.ok(since.length >= 1);
	assert.equal(compareVersions('2.1.10', '2.1.9') > 0, true);
});

test('the manifest version is x.y.z and listed in versions.json (required by the Obsidian plugin review)', async () => {
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
	const versions = (await import('../versions.json')).default as Record<string, string>;
	assert.equal(versions[manifest.version], manifest.minAppVersion);
	for (const key of Object.keys(versions)) assert.match(key, /^\d+\.\d+\.\d+$/, `versions.json key ${key}`);
});
