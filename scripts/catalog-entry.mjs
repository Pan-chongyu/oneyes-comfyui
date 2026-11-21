function editable(entry) {
    if (entry?.slug !== 'oneyes-comfyui') throw new Error('请先读取已存在的 OneYes ComfyUI 应用，不能用发布模板覆盖其他应用');
    const { id, updated_at, ...fields } = structuredClone(entry);
    return fields;
}

export function catalogRelease(entry, { version, downloads }) {
    const next = editable(entry);
    next.version = version;
    next.downloads = structuredClone(downloads);
    if (next.detection) next.detection.latest_version = version;
    return next;
}

// Only an explicit request to edit the listing may call this function.
export function catalogPresentation(entry, { summary, description, presentation }) {
    return { ...editable(entry), summary, description, presentation: structuredClone(presentation) };
}
