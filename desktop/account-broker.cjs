// Adapted from OneYes Canvas (MIT); see docs/CANVAS-MIT-LICENSE.txt.
const { readFile, lstat } = require('node:fs/promises');
const { join } = require('node:path');
const { homedir } = require('node:os');
const net = require('node:net');

function brokerDirectory() {
    const base = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin'
        ? join(homedir(), 'Library/Application Support') : process.env.XDG_DATA_HOME || join(homedir(), '.local/share');
    if (!base) throw new Error('无法读取 OneYes 用户目录');
    return join(base, 'ai.oneyes.desktop/canvas-link');
}
async function brokerCall(operation, args = {}, accountId, directory = brokerDirectory()) {
    if (!['profile', 'groups', 'keys', 'key'].includes(operation)) throw new Error('不支持的本机账户操作');
    try {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || (process.getuid && (metadata.uid !== process.getuid() || (metadata.mode & 0o077)))) throw new Error('OneYes 本机连接权限无效');
        const file = join(directory, 'connection.json'), metadataFile = await lstat(file);
        if (!metadataFile.isFile() || metadataFile.isSymbolicLink() || (process.getuid && (metadataFile.uid !== process.getuid() || (metadataFile.mode & 0o077)))) throw new Error('OneYes 本机连接权限无效');
        const info = JSON.parse(await readFile(file, 'utf8'));
        const validEndpoint = process.platform === 'win32' ? /^\\\\\.\\pipe\\OneYesCanvas-[A-Za-z0-9_-]+$/.test(info.endpoint) : info.endpoint === join(directory, 'canvas.sock');
        if (!validEndpoint || !/^[A-Za-z0-9_-]{43}$/.test(info.secret)) throw new Error('OneYes 本机连接无效');
        return await new Promise((resolve, reject) => {
            const socket = net.createConnection(info.endpoint);
            let response = '', settled = false;
            const finish = (error, data) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(data); };
            socket.setEncoding('utf8');
            socket.setTimeout(30000, () => finish(new Error('OneYes 客户端暂未响应，请稍后重新连接')));
            socket.on('connect', () => socket.write(JSON.stringify({ secret: info.secret, operation, args, account_id: accountId }) + '\n'));
            socket.on('data', data => {
                response += data;
                const end = response.indexOf('\n');
                if (end < 0) return;
                try { const value = JSON.parse(response.slice(0, end)); finish(value.error ? new Error(value.error) : null, value.data); }
                catch { finish(new Error('OneYes 本机响应无效')); }
            });
            socket.on('error', () => finish(new Error('请先打开并登录 OneYes 客户端，再复用登录态')));
            socket.on('close', () => { if (!settled) finish(new Error('OneYes 本机连接已断开，请重新连接')); });
        });
    } catch (error) {
        if (error.code === 'ENOENT') throw new Error('请先打开并登录 OneYes 客户端，再复用登录态');
        throw error;
    }
}
module.exports = { brokerCall, brokerDirectory };
