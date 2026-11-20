import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, copyFile, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';

const uvVersion = '0.13.9';
const assets = {
    'win32-x64': ['uv-x86_64-pc-windows-msvc.zip', 'edd61f7f5728a56cc62455386661860bdfc7bab65872f39b0c25bdcc1d8e1beb'],
    'darwin-arm64': ['uv-aarch64-apple-darwin.tar.gz', '5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca'],
    'linux-x64': ['uv-x86_64-unknown-linux-gnu.tar.gz', 'a7fbaff2b9a271d85c1bdb540941090fd1ce011797b4abeb48e4dcd39c2471d5'],
    'linux-arm64': ['uv-aarch64-unknown-linux-gnu.tar.gz', '0797542018e541a9288855df555c8077eed06f7a47d206362030480e8ecc9f3d'],
};
const target = assets[`${process.platform}-${process.arch}`];
if (!target) throw new Error('首版仅支持 Windows x64、macOS ARM64、Linux x64 / ARM64');
const root = process.cwd(), engine = path.join(root, 'desktop/engine');
await rm(engine, { recursive: true, force: true });
await mkdir(engine, { recursive: true });
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of new Set(files)) {
    if (/^(\.github|\.ci|desktop|test-desktop|test-oneyes|tests|tests-unit|docs|scripts|node_modules|dist|\.secrets)\//.test(file) || /^(package(-lock)?\.json|AGENTS\.md)$/.test(file)) continue;
    const output = path.join(engine, file);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(file, output);
}
const bin = path.join(root, 'desktop/bin');
await mkdir(bin, { recursive: true });
const [name, digest] = target, cached = path.join(bin, name);
let bytes;
try { bytes = await readFile(cached); } catch {}
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== digest) {
    const args = ['--fail', '--location', '--retry', '3', '--connect-timeout', '30', '--silent', '--show-error', '--output', cached, `https://github.com/astral-sh/uv/releases/download/${uvVersion}/${name}`];
    if (process.env.COMFY_SETUP_PROXY) args.unshift('--proxy', process.env.COMFY_SETUP_PROXY);
    execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { stdio: 'inherit', windowsHide: true });
    bytes = await readFile(cached);
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('uv SHA-256 mismatch');
    await writeFile(cached, bytes);
}
const unpack = path.join(bin, 'unpack');
await rm(unpack, { recursive: true, force: true }); await mkdir(unpack);
if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', cached, '-C', unpack], { windowsHide: true });
    await copyFile(path.join(unpack, 'uv.exe'), path.join(bin, 'uv.exe'));
} else {
    execFileSync('tar', ['-xzf', cached, '-C', unpack]);
    await copyFile(path.join(unpack, name.replace(/\.tar\.gz$/, ''), 'uv'), path.join(bin, 'uv'));
    await chmod(path.join(bin, 'uv'), 0o755);
}
await rm(unpack, { recursive: true, force: true });
await rm(cached);
console.log(`Prepared ComfyUI engine (${files.length} source entries), verified uv ${uvVersion} for ${process.platform}-${process.arch}`);
