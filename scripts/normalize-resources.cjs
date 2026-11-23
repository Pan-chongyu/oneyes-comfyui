const { readdir, utimes } = require('node:fs/promises');
const path = require('node:path');

// ZIP/TAR timestamps otherwise change unchanged resources on every runner.
const timestamp = new Date('2000-01-01T00:00:00Z');
async function normalizeDirectory(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, item.name);
        if (item.isDirectory()) await normalizeDirectory(file);
        else if (item.isFile()) await utimes(file, timestamp, timestamp);
    }
    await utimes(directory, timestamp, timestamp);
}
module.exports = async () => {
    for (const name of ['engine', 'python', 'frontend']) await normalizeDirectory(path.resolve('desktop', name));
};
module.exports.normalizeDirectory = normalizeDirectory;
