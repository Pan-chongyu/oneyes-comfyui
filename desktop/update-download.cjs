const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');

const CHUNK_SIZE = 8 * 1024 * 1024;
const CONNECTIONS = 3;
const diskErrors = new Set(['ENOSPC', 'EIO', 'EACCES', 'EPERM', 'EBADF']);

// Write disjoint ranges directly into the installer. File length alone cannot
// prove completion: a later range can leave holes before it after interruption.
async function downloadRanges({ entry, outputFile, fetcher, signal, baseFile, operations = [{ start: 0, end: entry.size }], identity = JSON.stringify([entry.url, entry.size, entry.sha256]), changed = () => {} }) {
    const parts = [];
    let position = 0;
    for (const op of operations) {
        const length = op.end - op.start;
        for (let offset = 0; offset < length; offset += CHUNK_SIZE) parts.push({ start: position + offset, end: position + Math.min(length, offset + CHUNK_SIZE), source: op.start + offset, copy: Boolean(op.copy) });
        position += length;
    }
    if (position !== entry.size) throw new Error('更新分块计划无效');
    const receipt = outputFile + '.json';
    const discard = async () => { await fs.rm(outputFile, { force: true }); await fs.rm(receipt, { force: true }); };
    let offsets = parts.map(() => 0), validator, exists = false;
    try {
        const [info, saved] = await Promise.all([fs.lstat(outputFile), fs.readFile(receipt, 'utf8').then(JSON.parse)]);
        if (!info.isFile() || info.size > entry.size) throw new Error('更新缓存无效');
        if (saved.schema === 1 && saved.identity === identity && Array.isArray(saved.offsets) && saved.offsets.length === parts.length && saved.offsets.every((n, i) => Number.isSafeInteger(n) && n >= 0 && n <= parts[i].end - parts[i].start && (!n || parts[i].start + n <= info.size))) offsets = saved.offsets;
        else if (!saved.schema && (saved.identity === identity || !baseFile && saved.url === entry.url && saved.size === entry.size && saved.sha256 === entry.sha256)) offsets = parts.map(part => Math.min(part.end - part.start, Math.max(0, info.size - part.start)));
        else throw new Error('更新缓存已变更');
        validator = typeof saved.validator === 'string' && !saved.validator.startsWith('W/') ? saved.validator : undefined;
        exists = true;
    } catch { await discard(); }
    signal?.throwIfAborted();
    const controller = new AbortController(), transferSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const handle = await fs.open(outputFile, exists ? 'r+' : 'w+', 0o600);
    let checkpoint = Promise.resolve(), reported = '';
    function save() {
        checkpoint = checkpoint.then(async () => {
            const snapshot = offsets.slice();
            await handle.sync();
            await fs.writeFile(receipt + '.tmp', JSON.stringify({ schema: 1, identity, validator, offsets: snapshot }), { mode: 0o600 });
            await fs.rename(receipt + '.tmp', receipt);
        });
        return checkpoint;
    }
    const total = parts.reduce((n, part) => n + (part.copy ? 0 : part.end - part.start), 0);
    const chunks = parts.filter(part => !part.copy).length;
    function report() {
        let downloaded = 0, completedChunks = 0;
        parts.forEach((part, i) => { if (!part.copy) { downloaded += offsets[i]; if (offsets[i] === part.end - part.start) completedChunks++; } });
        const progress = total ? Math.floor(downloaded / total * 100) : 100, next = `${progress}:${completedChunks}`;
        if (next !== reported) { reported = next; changed({ downloaded, total, progress, chunks, completedChunks, phase: '' }); }
    }
    async function transfer(index) {
        transferSignal.throwIfAborted();
        const part = parts[index], length = part.end - part.start;
        if (offsets[index] === length) return;
        let body;
        if (part.copy) body = createReadStream(baseFile, { start: part.source + offsets[index], end: part.source + length - 1, signal: transferSignal });
        else {
            const start = part.start + offsets[index], end = part.end - 1;
            let response;
            try { response = await fetcher(entry.url, { signal: transferSignal, cache: 'no-store', headers: { Range: `bytes=${start}-${end}`, ...(validator ? { 'If-Range': validator } : {}) } }); }
            catch (error) { error.resumableDownload = true; throw error; }
            if ([408, 429].includes(response.status) || response.status >= 500) {
                await response.body?.cancel();
                throw Object.assign(new Error('更新服务暂时不可用，重试后将继续下载'), { resumableDownload: true, status: response.status });
            }
            const etag = response.headers.get('etag');
            if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${entry.size}` || !response.body || validator && etag && validator !== etag) {
                await response.body?.cancel();
                throw Object.assign(new Error('更新服务暂不支持分块续传，改用完整更新包'), { rangeUnsupported: true, status: response.status });
            }
            if (etag && !etag.startsWith('W/')) validator ||= etag;
            body = response.body;
        }
        try {
            for await (const chunk of body) {
                transferSignal.throwIfAborted();
                if (offsets[index] + chunk.length > length) throw new Error('更新分块长度无效');
                let written = 0;
                while (written < chunk.length) {
                    const { bytesWritten } = await handle.write(chunk, written, chunk.length - written, part.start + offsets[index]);
                    if (!bytesWritten) throw Object.assign(new Error('无法写入更新包'), { code: 'EIO' });
                    written += bytesWritten; offsets[index] += bytesWritten;
                }
                if (!part.copy) report();
            }
        } catch (error) {
            if (!part.copy && !diskErrors.has(error.code) && !/分块长度/.test(error.message)) error.resumableDownload = true;
            throw error;
        }
        if (offsets[index] !== length) throw Object.assign(new Error('更新分块下载中断，重试后将继续下载'), { resumableDownload: !part.copy });
        if (!part.copy) await save();
    }
    try {
        await save(); report();
        // Establish Range support and a stable validator before opening peers.
        const probe = parts.findIndex((part, i) => !part.copy && offsets[i] < part.end - part.start);
        if (probe !== -1) await transfer(probe);
        let next = 0, failure;
        async function worker() {
            while (!transferSignal.aborted && next < parts.length) {
                const index = next++;
                try { await transfer(index); }
                catch (error) { failure ||= error; controller.abort(); }
            }
        }
        await Promise.all(Array.from({ length: CONNECTIONS }, worker));
        if (failure) throw failure;
        transferSignal.throwIfAborted();
        report();
        return { total, downloaded: total, chunks, completedChunks: chunks };
    } finally {
        controller.abort();
        try { await save(); } finally { await handle.close(); }
    }
}

module.exports = { downloadRanges, CHUNK_SIZE, CONNECTIONS };
