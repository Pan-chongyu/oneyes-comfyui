import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogRelease, catalogPresentation } from '../scripts/catalog-entry.mjs';

test('release sync changes versions and packages while preserving all maintained listing content', () => {
    const original = {
        id: 'catalog-id', updated_at: 123, revision: 18,
        slug: 'oneyes-comfyui', name: 'OneYes ComfyUI', category: 'software',
        version: '0.1.11', downloads: [{ filename: 'old.exe' }],
        detection: { kind: 'oneyes-comfyui', latest_version: '0.1.11' },
        summary: '用户维护的摘要', description: '用户维护的使用步骤',
        presentation: { description: '详细用途', source_url: 'https://example.com/docs', screenshots: [{ url: 'https://example.com/shot.webp', caption: '工作流实拍', source_url: 'https://example.com/source' }] },
        icon_url: '/media/catalog-icons/custom.png', publisher: 'OneYes',
        sort_order: 37, status: 'published', homepage: 'https://example.com', installation: { kind: 'software', targets: [] },
    };
    const before = structuredClone(original), downloads = [{ filename: 'new.exe', sha256: 'new-hash' }];
    const next = catalogRelease(original, { version: '0.1.12', downloads });
    const { id, updated_at, ...expected } = structuredClone(before);
    expected.version = '0.1.12'; expected.downloads = downloads; expected.detection.latest_version = '0.1.12';
    assert.deepEqual(next, expected);
    assert.deepEqual(original, before, 'Generating a sync must not mutate the cached server entry');
    next.presentation.screenshots[0].caption = 'changed';
    assert.equal(original.presentation.screenshots[0].caption, '工作流实拍');
    assert.throws(() => catalogRelease(null, { version: '0.1.12', downloads }), /读取已存在/);
    assert.throws(() => catalogRelease({ slug: 'other-app' }, { version: '0.1.12', downloads }), /覆盖其他应用/);
});

test('explicit presentation updates preserve installation, ordering, icon and version', () => {
    const original = { id: 'app', updated_at: 100, slug: 'oneyes-comfyui', revision: 18, version: '0.1.11', downloads: [{ filename: 'keep.exe' }], sort_order: 35, status: 'published', icon_url: '/keep.png', summary: 'old', description: 'old', presentation: { screenshots: [] } };
    const details = { summary: '详细用途摘要', description: '使用步骤', presentation: { description: '完整介绍', source_url: 'https://example.com', screenshots: [{ url: 'https://example.com/shot.webp', caption: '实拍', source_url: 'https://example.com' }] } };
    const next = catalogPresentation(original, details);
    const { id, updated_at, ...expected } = original;
    assert.deepEqual(next, { ...expected, ...details });
    assert.deepEqual(original.presentation.screenshots, []);
});
