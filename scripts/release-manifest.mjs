import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { createHash, createPrivateKey, sign, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { filename, platformKey, RELEASE_ROOT, readManifest } = require('../desktop/update-policy.cjs');
const directory = path.resolve(process.argv[2] || 'release');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const targets = [
    { platform: 'win32', arch: 'x64', format: 'nsis' },
    { platform: 'darwin', arch: 'arm64', format: 'zip' },
    ...['x64', 'arm64'].flatMap(arch => ['AppImage', 'deb', 'rpm'].map(format => ({ platform: 'linux', arch, format }))),
];
const names = await readdir(directory);
const expected = [...targets.map(t => filename(version, t.platform, t.arch, t.format)), filename(version, 'darwin', 'arm64', 'dmg')];
const platforms = {}, sums = [];
for (const name of expected) {
    assert.ok(names.includes(name), `Missing ${name}`);
    const bytes = await readFile(path.join(directory, name)), size = bytes.length, sha256 = createHash('sha256').update(bytes).digest('hex');
    assert.ok(size > 1000000, `Invalid installer ${name}`);
    sums.push(`${sha256}  ${name}`);
    const target = targets.find(t => name === filename(version, t.platform, t.arch, t.format));
    if (target) {
        const entry = { file: name, url: `${RELEASE_ROOT}/download/v${version}/${name}`, size, sha256 };
        if (target.platform === 'win32') {
            const file = name + '.blockmap', bytes = await readFile(path.join(directory, file));
            entry.blockmap = { file, url: `${RELEASE_ROOT}/download/v${version}/${file}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
            sums.push(`${entry.blockmap.sha256}  ${file}`);
        }
        platforms[platformKey(target)] = entry;
    }
}
const text = JSON.stringify({ schema: 1, version, notes: '首个 OneYes ComfyUI 桌面版：Key 本机加密、文字与异步图片节点、参考图编辑、原任务取回、自动配置运行环境。', platforms }, null, 2) + '\n';
if (!process.env.COMFY_OTA_PRIVATE_KEY) throw new Error('COMFY_OTA_PRIVATE_KEY secret is required');
const privateKey = createPrivateKey(process.env.COMFY_OTA_PRIVATE_KEY);
const signature = sign(null, Buffer.from(text), privateKey).toString('base64');
const publicKey = require('../desktop/update-key.cjs');
assert.ok(verify(null, Buffer.from(text), publicKey, Buffer.from(signature, 'base64')));
for (const target of targets) assert.equal(readManifest(text, signature, target).version, version);
await writeFile(path.join(directory, 'comfy-latest.json'), text);
await writeFile(path.join(directory, 'comfy-latest.json.sig'), signature + '\n');
await writeFile(path.join(directory, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(JSON.stringify({ version, installers: expected.length, signedTargets: targets.length, signatureVerified: true }));
