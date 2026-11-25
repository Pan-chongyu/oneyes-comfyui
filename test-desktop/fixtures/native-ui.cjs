const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { clipboard, dialog, Menu } = require('electron');

module.exports = async ({ window, directory, js, waitFor }) => {
    const showMessageBox = dialog.showMessageBox, popup = Menu.prototype.popup, copyText = clipboard.writeText;
    const answers = [], dialogs = [], menus = [], copied = [];
    dialog.showMessageBox = async (parent, options) => {
        assert.equal(parent, window, 'Native dialogs must stay attached to the canvas window');
        dialogs.push(options);
        const answer = answers.shift();
        assert.ok(answer, 'Unexpected native confirmation: ' + options.title);
        return answer;
    };
    clipboard.writeText = value => copied.push(value);
    Menu.prototype.popup = function (options) { assert.equal(options.window, window); menus.push(this); };
    try {
        await js(`(async()=>{
            const native=await fetch('/oneyes-native.js').then(r=>r.text());
            const file=native.match(/from '\\.\\/assets\\/(dialogService-[^']+)'/)[1];
            const source=await fetch('/assets/'+file).then(r=>r.text());
            const name=source.match(/useDialogService as (\\w+)/)[1];
            window.nativeDialogs=(await import('/assets/'+file))[name]();
        })()`);
        for (const [type, response, expected] of [['default', 1, true], ['delete', 0, null], ['overwrite', 1, true], ['dirtyClose', 0, null], ['dirtyClose', 1, false], ['dirtyClose', 2, true], ['info', 0, null]]) {
            answers.push({ response, checkboxChecked: false });
            assert.equal(await js(`window.nativeDialogs.confirm({title:'原生确认',message:'测试工作流操作',type:'${type}',itemList:['工作流 A','工作流 B'],hint:'保留任务记录',confirmLabel:'保存工作流',denyLabel:'放弃更改'})`), expected);
            const options = dialogs.at(-1);
            assert.equal(options.cancelId, 0);
            assert.match(options.detail, /工作流 A\n• 工作流 B\n保留任务记录/);
            if (type === 'dirtyClose') assert.deepEqual(options.buttons, ['取消', '放弃更改', '保存工作流']);
        }
        answers.push({ response: 1, checkboxChecked: true });
        assert.equal(await js(`window.nativeDialogs.confirm({title:'覆盖蓝图',message:'测试覆盖',type:'overwriteBlueprint'})`), true);
        assert.equal(await js(`window.comfyAPI.app.app.ui.settings.getSettingValue('Comfy.Workflow.WarnBlueprintOverwrite')`), false);
        assert.ok(dialogs.at(-1).checkboxLabel);
        await js(`window.comfyAPI.app.app.ui.settings.setSettingValueAsync('Comfy.Workflow.WarnBlueprintOverwrite',true)`);
        answers.push({ response: 0, checkboxChecked: true });
        await js(`window.nativeDialogs.confirm({title:'覆盖蓝图',message:'取消覆盖',type:'overwriteBlueprint'})`);
        assert.equal(await js(`window.comfyAPI.app.app.ui.settings.getSettingValue('Comfy.Workflow.WarnBlueprintOverwrite')`), true, 'Cancelling a checkbox dialog must preserve the preference');
        const count = dialogs.length;
        answers.push({ response: 1 });
        await js(`window.nativePrompt=window.nativeDialogs.prompt({title:'工作流名称',message:'请输入名称',defaultValue:'原工作流'});window.queuedConfirmation=window.nativeDialogs.confirm({title:'后续操作',message:'排队确认'});void 0`);
        await waitFor(window, `Boolean([...document.querySelectorAll('[role="dialog"]')].find(panel=>panel.textContent.includes('工作流名称')))`);
        assert.equal(dialogs.length, count, 'Confirmation must respect the original prompt queue');
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        assert.equal(await js(`window.nativePrompt`), null);
        assert.equal(await js(`window.queuedConfirmation`), true);
        const beforeClipboard = copied.length;
        await js(`window.oneYesDesktop.copyText('模型-id／任务-编号')`);
        assert.equal(copied[beforeClipboard], '模型-id／任务-编号');
        assert.match(await js(`window.oneYesDesktop.copyText({}).then(()=>'',error=>error.message)`), /复制内容无效/);
        const flags = { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true };
        window.webContents.emit('context-menu', {}, { isEditable: true, editFlags: flags, frame: window.webContents.mainFrame, menuSourceType: 'mouse' });
        assert.equal(menus.length, 1);
        assert.deepEqual(menus[0].items.filter(item=>item.role).map(item=>item.role), ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteandmatchstyle', 'delete', 'selectall']);
        window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: '', mediaType: 'canvas', editFlags: flags });
        assert.equal(menus.length, 1, 'The native text menu must leave graph menus alone');
        const file = path.join(directory, 'native-export.json'), expected = '{"nodes":[],"说明":"原始工作流内容"}';
        const completed = new Promise((resolve, reject) => window.webContents.session.once('will-download', (_event, item, source) => {
            try {
                assert.equal(source, window.webContents);
                const options = item.getSaveDialogOptions();
                assert.equal(options.title, '保存文件');
                assert.equal(path.basename(options.defaultPath), '原生导出.json');
                assert.ok(options.filters[0].extensions.includes('json'));
                item.setSavePath(file);
                item.once('done', (_event, state) => state === 'completed' ? resolve() : reject(new Error('Export did not complete: ' + state)));
            } catch (error) { item.cancel(); reject(error); }
        }));
        await js(`(()=>{const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([${JSON.stringify(expected)}],{type:'application/json'}));link.download='原生导出.json';document.body.append(link);link.click();link.remove()})()`);
        await completed;
        assert.equal(await fs.readFile(file, 'utf8'), expected, 'Native save must preserve every exported byte');
        const cancelled = new Promise(resolve => window.webContents.session.once('will-download', (_event, item) => {
            item.once('done', (_event, state) => resolve(state)); item.cancel();
        }));
        await js(`(()=>{const link=document.createElement('a');link.href=URL.createObjectURL(new Blob(['cancelled']));link.download='取消导出.txt';link.click()})()`);
        assert.equal(await cancelled, 'cancelled');
        assert.equal(await js(`fetch('/object_info/OneYesImage').then(r=>r.status)`), 200, 'Cancelled dialogs and exports must leave the real engine ready');
        console.log('Native components: confirmation results and queue, blueprint preference, system clipboard, text menus, exact file export and cancellation passed.');
    } finally {
        dialog.showMessageBox = showMessageBox; Menu.prototype.popup = popup; clipboard.writeText = copyText;
    }
};
