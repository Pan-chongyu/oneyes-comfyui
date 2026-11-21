const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');

async function availablePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function bundledPython(resources) {
    const prefix = path.join(resources, 'python');
    const expected = process.platform === 'win32' ? 'python.exe' : 'bin/python3.12';
    try {
        const manifest = JSON.parse(await fs.readFile(path.join(prefix, 'oneyes-runtime.json'), 'utf8'));
        const requirements = await Promise.all(['requirements.txt', 'oneyes/requirements.txt', 'oneyes/constraints.txt'].map(file => fs.readFile(path.join(resources, 'engine', file))));
        if (manifest.schema !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.python !== expected || manifest.requirements !== createHash('sha256').update(Buffer.concat(requirements)).digest('hex')) throw new Error('Runtime does not match engine');
        const python = path.join(prefix, expected);
        await fs.access(python);
        return python;
    } catch {
        throw new Error('内置运行环境不完整，请重新下载安装本版本；已保存的工作流和设置会保留。');
    }
}

function createRuntime({ resources, directory, changed = () => {} }) {
    const engine = path.join(resources, 'engine');
    const prefix = path.join(resources, 'python');
    const data = path.join(directory, 'comfy');
    const token = randomBytes(32).toString('hex');
    let processHandle, exit, operation, stopping = false;
    let state = { status: 'idle', phase: '', message: '', url: '' };
    const emit = patch => { state = { ...state, ...patch }; changed({ ...state }); };
    const env = { ...process.env, PYTHONHOME: prefix, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', ONEYES_DATA_DIR: directory, ONEYES_LOCAL_TOKEN: token, HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', XDG_CACHE_HOME: path.join(directory, 'cache'), HF_HOME: path.join(directory, 'cache/huggingface'), NUMBA_CACHE_DIR: path.join(directory, 'cache/numba') };
    delete env.PYTHONPATH; delete env.VIRTUAL_ENV; delete env.ONEYES_API_KEY;
    async function terminate() {
        if (!processHandle?.pid) return;
        if (process.platform === 'win32') {
            const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            await new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
        } else processHandle.kill('SIGTERM');
        await exit;
    }

    async function launch() {
        if (state.status === 'ready') return state;
        if (operation) return operation;
        stopping = false;
        operation = (async () => {
            emit({ status: 'starting', phase: '启动 ComfyUI', message: '正在加载内置运行环境' });
            const python = await bundledPython(resources);
            if (stopping) return state;
            for (const folder of ['user', 'input', 'output', 'models', 'custom_nodes']) await fs.mkdir(path.join(data, folder), { recursive: true });
            const extension = path.join(data, 'custom_nodes/oneyes');
            await fs.mkdir(extension, { recursive: true });
            await fs.copyFile(path.join(engine, 'oneyes/custom_node.py'), path.join(extension, '__init__.py'));
            await fs.cp(path.join(engine, 'oneyes/web'), path.join(extension, 'web'), { recursive: true, force: true });
            const port = await availablePort(), url = `http://127.0.0.1:${port}`;
            emit({ status: 'starting', phase: '启动 ComfyUI', message: '正在加载节点与画布', url });
            const child = spawn(python, [path.join(engine, 'main.py'), '--listen', '127.0.0.1', '--port', String(port), '--cpu', '--disable-auto-launch', '--disable-partner-nodes', '--front-end-root', path.join(resources, 'frontend'), '--base-directory', data], { cwd: engine, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            processHandle = child;
            let ended = false, log = '';
            const capture = bytes => { log = (log + bytes.toString()).slice(-6000); };
            child.stdout.on('data', capture); child.stderr.on('data', capture);
            exit = new Promise(resolve => child.once('close', resolve));
            child.once('error', error => { ended = true; log += error.message; processHandle = null; });
            child.once('exit', () => { ended = true; processHandle = null; if (!stopping) emit({ status: 'error', message: 'ComfyUI 已停止，请重新启动。若刚安装了其他节点，请检查该节点的运行依赖。' }); });
            while (!ended && !stopping) {
                let info;
                try {
                    const response = await fetch(`${url}/object_info/OneYesImage`, { signal: AbortSignal.timeout(3000) });
                    if (response.ok) info = await response.json();
                } catch {}
                if (info?.OneYesImage) { emit({ status: 'ready', phase: '就绪', message: '画布已就绪', url }); return state; }
                if (info) { await terminate(); break; }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (!stopping) {
                await fs.writeFile(path.join(directory, 'engine-error.log'), log.replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]'), { mode: 0o600 });
                throw new Error('画布启动失败，请重试；可打开数据目录查看 engine-error.log，或重新安装本版本。');
            }
        })().catch(error => { if (!stopping) emit({ status: 'error', message: error.message }); throw error; }).finally(() => { operation = null; });
        return operation;
    }
    return {
        state: () => ({ ...state }), token: () => token, launch, data,
        async stop() {
            stopping = true;
            await terminate();
            emit({ status: 'idle', phase: '', message: '', url: '' });
        },
    };
}
module.exports = { createRuntime, availablePort, bundledPython };
