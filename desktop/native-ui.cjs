const { app, dialog, Menu } = require('electron');
const path = require('node:path');

const types = new Set(['default', 'delete', 'overwrite', 'overwriteBlueprint', 'dirtyClose', 'reinstall', 'info']);
function confirmationOptions(value) {
    if (!value || !types.has(value.type) || !['title', 'message', 'confirmLabel', 'cancelLabel'].every(key => typeof value[key] === 'string' && !value[key].includes('\0')) || value.hint !== undefined && typeof value.hint !== 'string' || !Array.isArray(value.itemList) || value.itemList.some(item => typeof item !== 'string')) throw new Error('确认提示参数无效');
    if (value.type === 'dirtyClose' && typeof value.denyLabel !== 'string' || value.type === 'overwriteBlueprint' && typeof value.checkboxLabel !== 'string') throw new Error('确认提示按钮无效');
    const info = value.type === 'info', dirty = value.type === 'dirtyClose';
    return {
        title: value.title || 'OneYes ComfyUI',
        message: value.message,
        detail: [...value.itemList.map(item => `• ${item}`), value.hint || ''].filter(Boolean).join('\n'),
        type: info ? 'info' : ['delete', 'overwrite', 'overwriteBlueprint', 'reinstall'].includes(value.type) ? 'warning' : 'question',
        buttons: info ? [value.confirmLabel] : dirty ? [value.cancelLabel, value.denyLabel, value.confirmLabel] : [value.cancelLabel, value.confirmLabel],
        defaultId: dirty ? 2 : 0,
        cancelId: 0,
        noLink: true,
        ...(value.type === 'overwriteBlueprint' ? { checkboxLabel: value.checkboxLabel, checkboxChecked: false } : {}),
    };
}

function attachNativeUI(window, isCanvas) {
    const contents = window.webContents, session = contents.session;
    let dialogs = Promise.resolve();
    let saveDirectory = app.getPath('downloads');
    const downloads = new Set();
    const active = () => !window.isDestroyed() && !contents.isDestroyed() && isCanvas();
    async function confirm(value) {
        const options = confirmationOptions(value);
        const result = dialogs.then(async () => {
            if (!active()) return { value: null, checkboxChecked: false };
            const answer = await dialog.showMessageBox(window, options);
            const confirmed = value.type === 'info' || answer.response === 0 ? null : value.type === 'dirtyClose' ? answer.response === 2 : true;
            return { value: confirmed, checkboxChecked: Boolean(answer.checkboxChecked) };
        });
        dialogs = result.catch(() => {});
        return result;
    }
    function contextMenu(_event, params) {
        if (!active() || !params.isEditable && (!params.selectionText || params.mediaType !== 'none')) return;
        const flags = params.editFlags;
        const items = params.isEditable ? [
            { role: 'undo', label: '撤销', enabled: flags.canUndo }, { role: 'redo', label: '重做', enabled: flags.canRedo }, { type: 'separator' },
            { role: 'cut', label: '剪切', enabled: flags.canCut }, { role: 'copy', label: '复制', enabled: flags.canCopy },
            { role: 'paste', label: '粘贴', enabled: flags.canPaste }, { role: 'pasteAndMatchStyle', label: '粘贴为纯文本', enabled: flags.canPaste },
            { role: 'delete', label: '删除', enabled: flags.canDelete }, { type: 'separator' }, { role: 'selectAll', label: '全选', enabled: flags.canSelectAll },
        ] : [{ role: 'copy', label: '复制', enabled: flags.canCopy }];
        Menu.buildFromTemplate(items).popup({ window, frame: params.frame, sourceType: params.menuSourceType });
    }
    function updateProgress() {
        if (window.isDestroyed()) return;
        const items = [...downloads], total = items.reduce((bytes, item) => bytes + item.getTotalBytes(), 0);
        window.setProgressBar(!items.length ? -1 : total ? items.reduce((bytes, item) => bytes + item.getReceivedBytes(), 0) / total : 2);
    }
    function download(_event, item, source) {
        if (source !== contents || !active()) return;
        const name = path.basename(item.getFilename() || '下载文件'), extension = path.extname(name).slice(1);
        item.setSaveDialogOptions({
            title: '保存文件', buttonLabel: '保存', defaultPath: path.join(saveDirectory, name),
            properties: ['createDirectory', 'showOverwriteConfirmation'],
            ...(/^[a-zA-Z0-9]+$/.test(extension) ? { filters: [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }, { name: '所有文件', extensions: ['*'] }] } : {}),
        });
        downloads.add(item);
        item.on('updated', updateProgress);
        item.once('done', (_event, state) => {
            if (state === 'completed') saveDirectory = path.dirname(item.getSavePath());
            downloads.delete(item); item.removeListener('updated', updateProgress); updateProgress();
            if (state === 'interrupted' && active()) void confirm({ type: 'info', title: '保存未完成', message: '文件下载中断，请重新下载。', hint: '画布和任务记录已保留。', itemList: [name], confirmLabel: '知道了', cancelLabel: '关闭' }).catch(() => {});
        });
    }
    contents.on('context-menu', contextMenu);
    session.on('will-download', download);
    window.once('closed', () => { session.removeListener('will-download', download); });
    return { confirm };
}
module.exports = { attachNativeUI };
