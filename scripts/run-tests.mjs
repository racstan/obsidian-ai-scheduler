import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

mkdirSync('.tmp-tests', { recursive: true });
await build({
	entryPoints: ['tests/index.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'es2022',
	logLevel: 'warning',
	outfile: '.tmp-tests/index.test.cjs',
});

// Pin a DST-observing timezone so the daylight-saving tests are deterministic
// on every machine. All other expectations are timezone-agnostic.
const result = spawnSync(process.execPath, ['--test', '.tmp-tests/index.test.cjs'], {
	stdio: 'inherit',
	env: { ...process.env, TZ: 'America/New_York' },
});
process.exit(result.status ?? 1);
