import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rename, rm, copyFile, constants } from 'node:fs/promises';
import path from 'node:path';

const version = '3.12.16';
const targets = { 'win32-x64': 'windows-x86_64-none', 'darwin-arm64': 'macos-aarch64-none', 'linux-x64': 'linux-x86_64-gnu', 'linux-arm64': 'linux-aarch64-gnu' };
const target = targets[`${process.platform}-${process.arch}`];
if (!target) throw new Error('Unsupported desktop runtime target');
const root = process.cwd(), prefix = path.join(root, 'desktop/python'), staging = path.join(root, '.runtime/python-download');
const uv = path.join(root, 'desktop/bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
const interpreter = process.platform === 'win32' ? 'python.exe' : 'bin/python3.12';
const python = path.join(prefix, interpreter);
const requirements = ['requirements.txt', 'oneyes/requirements.txt', 'oneyes/constraints.txt'];
const identity = createHash('sha256').update(Buffer.concat(await Promise.all(requirements.map(file => readFile(file))))).digest('hex');
const env = { ...process.env, UV_PYTHON_INSTALL_DIR: staging, UV_CACHE_DIR: path.join(root, '.runtime/uv-cache'), UV_HTTP_TIMEOUT: '120', UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'manual', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' };
delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV;
if (process.env.COMFY_SETUP_PROXY) env.HTTPS_PROXY = env.HTTP_PROXY = process.env.COMFY_SETUP_PROXY;
const run = args => execFileSync(uv, args, { env, stdio: 'inherit', windowsHide: true });
async function windowsRuntime() {
    if (process.platform !== 'win32') return;
    const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
    const studio = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
    if (!studio) throw new Error('Visual C++ redistributable build files are missing');
    const redist = path.join(studio, 'VC/Redist/MSVC');
    const versions = (await readdir(redist)).filter(name => /^\d+\./.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const directory = path.join(redist, versions[0], 'x64');
    const crt = (await readdir(directory)).find(name => /^Microsoft\.VC\d+\.CRT$/.test(name));
    if (!crt) throw new Error('Missing app-local x64 Visual C++ runtime');
    for (const file of (await readdir(path.join(directory, crt))).filter(name => name.endsWith('.dll'))) {
        try { await copyFile(path.join(directory, crt, file), path.join(prefix, file), constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
}
let previous;
try { previous = JSON.parse(await readFile(path.join(prefix, 'oneyes-runtime.json'), 'utf8')); } catch {}
if (previous?.requirements === identity && previous.pythonVersion === version && previous.platform === process.platform && previous.arch === process.arch) {
    await windowsRuntime();
    execFileSync(python, ['-I', '-c', 'import torch, torchvision, aiohttp, cryptography, comfyui_frontend_package'], { env, stdio: 'inherit', windowsHide: true });
    console.log('Bundled Python and engine dependencies are already prepared');
} else {
    await mkdir(staging, { recursive: true });
    run(['python', 'install', `cpython-${version}-${target}`, '--install-dir', staging, '--no-bin', '--no-registry']);
    const installation = (await readdir(staging)).find(name => name === `cpython-${version}-${target}`);
    if (!installation) throw new Error('Managed Python installation was not found in the private build directory');
    await rm(prefix, { recursive: true, force: true });
    await rename(path.join(staging, installation), prefix);
    // Only the private standalone prefix is modified; no system Python or virtualenv is shipped.
    run(['pip', 'install', '--system', '--break-system-packages', '--python', python, '--no-deps', 'torch==2.15.0', 'torchvision==0.29.2', '--index-url', 'https://download.pytorch.org/whl/cpu']);
    run(['pip', 'install', '--system', '--break-system-packages', '--python', python, '-r', 'requirements.txt', '-r', 'oneyes/requirements.txt', '-c', 'oneyes/constraints.txt']);
    run(['pip', 'check', '--python', python]);
    await windowsRuntime();
    execFileSync(python, ['-I', '-c', 'import torch, torchvision, aiohttp, cryptography, comfyui_frontend_package; print("Bundled imports verified")'], { env, stdio: 'inherit', windowsHide: true });
    await writeFile(path.join(prefix, 'oneyes-runtime.json'), JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch, python: interpreter, pythonVersion: version, requirements: identity }, null, 2) + '\n');
    console.log(`Prepared offline runtime: Python ${version}, ${process.platform}-${process.arch}`);
}
execFileSync(python, ['-I', '-m', 'compileall', '-q', '-j', '2', '--invalidation-mode', 'unchecked-hash', path.join(prefix, process.platform === 'win32' ? 'Lib' : 'lib/python3.12'), path.join(root, 'desktop/engine')], { env, stdio: 'inherit', windowsHide: true });
console.log('Precompiled engine and dependencies for startup without modifying the installed app');
