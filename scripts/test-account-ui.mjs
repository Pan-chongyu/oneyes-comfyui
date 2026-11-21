import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const directory = await mkdtemp(path.join(tmpdir(), 'comfy-ui-result-'));
env.COMFY_ACCOUNT_TEST_RESULT = path.join(directory, 'result');
const fixture = path.resolve('test-desktop/fixtures/account-ui.cjs');
const command = process.platform === 'linux' ? 'xvfb-run' : electron;
const args = process.platform === 'linux' ? ['-a', electron, '--no-sandbox', fixture] : [fixture];
const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', async (code, signal) => {
    try {
        if (signal || code !== 0 || await readFile(env.COMFY_ACCOUNT_TEST_RESULT, 'utf8') !== 'passed') throw new Error('Account UI test did not complete successfully');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await rm(directory, { recursive: true, force: true }); }
});
