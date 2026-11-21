const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

function createEncryptedStore(directory, filename) {
    const file = path.join(directory, filename), master = path.join(directory, filename.replace(/\.json$/, '.master'));
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
    function update(action) {
        const next = operation.then(async () => {
            const values = await action(await read());
            const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', await key(), iv);
            const data = Buffer.concat([cipher.update(JSON.stringify(values)), cipher.final(), cipher.getAuthTag()]);
            const temporary = file + '.tmp';
            await fs.writeFile(temporary, JSON.stringify({ iv: iv.toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
            await fs.rename(temporary, file);
        });
        operation = next.catch(() => {});
        return next;
    }
    return { read: async () => { await operation; return read(); }, update, write: values => update(() => values) };
}

const profiles = ['default', 'image', 'text'];
function createVault(directory) {
    const store = createEncryptedStore(directory, 'vault.json');
    function validate(changes) {
        if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.entries(changes).some(([name, value]) => !profiles.includes(name) || typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error('Key 设置无效');
    }
    function assign(values, changes, accountId) {
        values._owners ||= {};
        for (const [name, value] of Object.entries(changes)) {
            if (value.trim()) values[name] = value.trim(); else delete values[name];
            if (accountId && value.trim()) values._owners[name] = accountId; else delete values._owners[name];
        }
        return values;
    }
    return {
        async status() { const values = await store.read(); return Object.fromEntries(profiles.map(name => [name, Boolean(values[name])])); },
        async save(changes) { validate(changes); await store.update(values => assign(values, changes)); },
        async saveAccount(accountId, changes) {
            validate(changes);
            if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new Error('账户无效');
            await store.update(values => assign(values, changes, accountId));
        },
        clearAccount(exceptId) {
            return store.update(values => {
                for (const [name, id] of Object.entries(values._owners || {})) {
                    if (id !== exceptId) { delete values[name]; delete values._owners[name]; }
                }
                return values;
            });
        },
    };
}
module.exports = { createVault, createEncryptedStore };
