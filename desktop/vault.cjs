const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

function createVault(directory) {
    const file = path.join(directory, 'vault.json'), master = path.join(directory, 'vault.master');
    let operation = Promise.resolve();
    async function key() {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        try { await fs.writeFile(master, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        return fs.readFile(master);
    }
    async function read() {
        let envelope;
        try { envelope = JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
        const bytes = Buffer.from(envelope.data, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(bytes.subarray(-16));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString());
    }
    return {
        async status() { const values = await read(); return Object.fromEntries(['default', 'image', 'text'].map(name => [name, Boolean(values[name])])); },
        save(changes) {
            const action = operation.then(async () => {
                if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.entries(changes).some(([name, value]) => !['default', 'image', 'text'].includes(name) || typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error('Key 设置无效');
                const values = await read();
                for (const [name, value] of Object.entries(changes)) { if (value.trim()) values[name] = value.trim(); else delete values[name]; }
                const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(), iv);
                const data = Buffer.concat([cipher.update(JSON.stringify(values)), cipher.final(), cipher.getAuthTag()]);
                const temporary = file + '.tmp';
                await fs.writeFile(temporary, JSON.stringify({ iv: iv.toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
                await fs.rename(temporary, file);
            });
            operation = action.catch(() => {});
            return action;
        },
    };
}
module.exports = { createVault };
