import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createVault } = require('../desktop/vault.cjs');
const { filename, readManifest, RELEASE_ROOT, platformKey } = require('../desktop/update-policy.cjs');

test('OTA pins repository, architecture, install format and Ed25519 identity', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const target = { platform: 'linux', arch: 'arm64', format: 'deb' }, version = '0.1.1';
    const name = filename(version, target.platform, target.arch, target.format);
    assert.equal(name, 'OneYes-ComfyUI-0.1.1-Linux-arm64.deb');
    const entry = { file: name, url: `${RELEASE_ROOT}/download/v${version}/${name}`, size: 1000, sha256: 'a'.repeat(64) };
    const text = JSON.stringify({ schema: 1, version, notes: '', platforms: { [platformKey(target)]: entry } });
    const signature = sign(null, Buffer.from(text), privateKey).toString('base64');
    assert.equal(readManifest(text, signature, target, publicKey).version, version);
    assert.throws(() => readManifest(text.replace('0.1.1', '9.1.1'), signature, target, publicKey), /签名/);
    assert.throws(() => readManifest(text, signature, { ...target, format: 'rpm' }, publicKey), /安装格式/);
    assert.throws(() => readManifest(text, signature, { ...target, arch: 'x64' }, publicKey), /安装格式/);
    assert.throws(() => readManifest(text, signature, target, generateKeyPairSync('ed25519').publicKey), /签名/);
});

test('local vault stores no plaintext, serializes changes, supports clearing', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'comfy-vault-'));
    try {
        const vault = createVault(directory);
        await Promise.all([vault.save({ default: 'private-default' }), vault.save({ image: 'private-image' })]);
        assert.deepEqual(await vault.status(), { default: true, image: true, text: false });
        assert.equal((await readFile(path.join(directory, 'vault.json'), 'utf8')).includes('private'), false);
        await assert.rejects(vault.save({ url: 'https://untrusted.test' }), /无效/);
        await vault.save({ image: '' });
        assert.deepEqual(await createVault(directory).status(), { default: true, image: false, text: false });
    } finally { await rm(directory, { recursive: true, force: true }); }
});
