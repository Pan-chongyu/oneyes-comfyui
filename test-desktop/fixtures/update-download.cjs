const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { net } = require('electron');
const { downloadRanges, CHUNK_SIZE, CONNECTIONS } = require('../../desktop/update-download.cjs');
const { validateFile } = require('../../desktop/updater.cjs');

module.exports = async directory => {
    const bytes = Buffer.alloc(CHUNK_SIZE * 4, 0x71), waiting = [];
    let requests = 0, peak = 0;
    const server = createServer((request, response) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        assert.ok(match, 'Electron must preserve the updater Range header');
        const start = Number(match[1]), end = Number(match[2]);
        const finish = () => { response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${bytes.length}`, etag: '"electron-test"' }); response.end(bytes.subarray(start, end + 1)); };
        requests++;
        if (requests === 1) finish();
        else { waiting.push(finish); peak = Math.max(peak, waiting.length); if (waiting.length === CONNECTIONS) waiting.splice(0).reverse().forEach(done => done()); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const entry = { url: `http://127.0.0.1:${server.address().port}/installer`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        const outputFile = path.join(directory, 'native-update.part');
        await downloadRanges({ entry, outputFile, fetcher: (url, init) => net.fetch(url, init) });
        await validateFile(outputFile, entry);
        assert.equal(requests, 4); assert.equal(peak, CONNECTIONS);
        console.log('Native updater transport: parallel Electron Range requests and exact installer checksum passed.');
    } finally { server.closeAllConnections(); server.close(); }
};
