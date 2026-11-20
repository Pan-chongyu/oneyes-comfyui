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

function createRuntime({ resources, directory, changed = () => {} }) {
    const engine = path.join(resources, 'engine');
    const uv = path.join(resources, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
    const venv = path.join(directory, 'runtime');
    const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const data = path.join(directory, 'comfy');
    const token = randomBytes(32).toString('hex');
    let processHandle, exit, operation, stopping = false;
    let state = { status: 'idle', phase: '', message: '', url: '' };
    const emit = patch => { state = { ...state, ...patch }; changed({ ...state }); };
    const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(directory, 'python'), UV_CACHE_DIR: path.join(directory, 'uv-cache'), UV_HTTP_TIMEOUT: '120', PYTHONUNBUFFERED: '1', ONEYES_DATA_DIR: directory, ONEYES_LOCAL_TOKEN: token, HF_HUB_DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
    delete env.PYTHONHOME; delete env.PYTHONPATH; delete env.VIRTUAL_ENV; delete env.ONEYES_API_KEY;

    async function command(args, phase) {
        emit({ status: 'installing', phase, message: phase });
        const child = spawn(uv, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        processHandle = child;
        let tail = '';
        const onData = bytes => {
            tail = (tail + bytes.toString()).slice(-6000);
            const line = tail.split(/[\r\n]+/).filter(Boolean).at(-1) || phase;
            emit({ message: line.replace(/https?:\/\/\S+/g, '依赖源').slice(0, 180) });
        };
        child.stdout.on('data', onData); child.stderr.on('data', onData);
        exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${phase}失败，请检查网络并点击重试。${tail.split(/[\r\n]+/).filter(Boolean).at(-1)?.replace(/https?:\/\/\S+/g, '依赖源').slice(0, 200) || ''}`))); });
        try { await exit; }
        catch (error) { await fs.writeFile(path.join(directory, 'runtime-error.log'), tail.replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]'), { mode: 0o600 }); throw error; }
        finally { processHandle = null; }
    }

    async function install() {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const requirements = await Promise.all(['requirements.txt', 'oneyes/requirements.txt', 'oneyes/constraints.txt'].map(file => fs.readFile(path.join(engine, file))));
        const identity = createHash('sha256').update(Buffer.concat(requirements)).digest('hex');
        let ready = false;
        try { ready = (await fs.readFile(path.join(venv, 'oneyes-ready'), 'utf8')) === identity; await fs.access(python); } catch {}
        if (ready) return;
        try { await fs.access(python); } catch { await command(['venv', '--python', '3.12', '--managed-python', venv], '准备独立 Python'); }
        await command(['pip', 'install', '--python', python, '--no-deps', 'torch==2.15.0', 'torchvision==0.29.2', '--index-url', 'https://download.pytorch.org/whl/cpu'], '安装 CPU 推理运行时');
        await command(['pip', 'install', '--python', python, '-r', path.join(engine, 'requirements.txt'), '-r', path.join(engine, 'oneyes/requirements.txt'), '-c', path.join(engine, 'oneyes/constraints.txt')], '安装 ComfyUI 和 OneYes 节点依赖');
        await fs.writeFile(path.join(venv, 'oneyes-ready'), identity, { mode: 0o600 });
    }

    async function launch() {
        if (state.status === 'ready') return state;
        if (operation) return operation;
        stopping = false;
        operation = (async () => {
            await install();
            for (const folder of ['user', 'input', 'output', 'models', 'custom_nodes']) await fs.mkdir(path.join(data, folder), { recursive: true });
            const extension = path.join(data, 'custom_nodes/oneyes');
            await fs.mkdir(extension, { recursive: true });
            await fs.copyFile(path.join(engine, 'oneyes/custom_node.py'), path.join(extension, '__init__.py'));
            await fs.cp(path.join(engine, 'oneyes/web'), path.join(extension, 'web'), { recursive: true, force: true });
            const port = await availablePort(), url = `http://127.0.0.1:${port}`;
            emit({ status: 'starting', phase: '启动 ComfyUI', message: '正在加载节点与画布', url });
            const child = spawn(python, [path.join(engine, 'main.py'), '--listen', '127.0.0.1', '--port', String(port), '--cpu', '--disable-auto-launch', '--disable-partner-nodes', '--base-directory', data], { cwd: engine, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            processHandle = child;
            let ended = false, log = '';
            const capture = bytes => { log = (log + bytes.toString()).slice(-6000); };
            child.stdout.on('data', capture); child.stderr.on('data', capture);
            exit = new Promise(resolve => child.once('exit', resolve));
            child.once('error', () => { ended = true; });
            child.once('exit', () => { ended = true; processHandle = null; if (!stopping) emit({ status: 'error', message: 'ComfyUI 已停止，请重新启动。若刚安装了其他节点，请检查该节点的运行依赖。' }); });
            while (!ended && !stopping) {
                try {
                    const response = await fetch(`${url}/object_info/OneYesImage`, { signal: AbortSignal.timeout(3000) });
                    if (response.ok && (await response.json()).OneYesImage) { emit({ status: 'ready', phase: '就绪', message: '画布已就绪', url }); return state; }
                } catch {}
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            if (!stopping) {
                await fs.writeFile(path.join(directory, 'engine-error.log'), log.replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]'), { mode: 0o600 });
                throw new Error('ComfyUI 启动失败。可打开数据目录查看 engine-error.log，修复依赖后重试。');
            }
        })().catch(error => { if (!stopping) emit({ status: 'error', message: error.message }); throw error; }).finally(() => { operation = null; });
        return operation;
    }
    return {
        state: () => ({ ...state }), token: () => token, launch, data,
        async stop() {
            stopping = true;
            if (processHandle) {
                if (process.platform === 'win32') {
                    const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(processHandle.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                    await new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
                } else processHandle.kill('SIGTERM');
                await exit;
            }
            emit({ status: 'idle', phase: '', message: '', url: '' });
        },
    };
}
module.exports = { createRuntime, availablePort };
