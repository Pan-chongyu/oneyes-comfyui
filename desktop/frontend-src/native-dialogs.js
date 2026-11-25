const types = new Set(['default', 'delete', 'overwrite', 'overwriteBlueprint', 'dirtyClose', 'reinstall', 'info']);
export function supportsNativeConfirmation(options) {
    return Boolean(window.oneYesDesktop && types.has(options.type || 'default') && typeof options.title === 'string' && typeof options.message === 'string');
}
export async function confirmNative(options, translate) {
    const bridge = window.oneYesDesktop, type = options.type || 'default';
    const keys = { default: 'g.confirm', delete: 'g.delete', overwrite: 'g.overwrite', overwriteBlueprint: 'g.overwrite', dirtyClose: 'g.save', reinstall: 'desktopMenu.reinstall', info: 'g.ok' };
    const answer = await bridge.confirm({
        type, title: options.title, message: options.message, itemList: options.itemList || [], hint: options.hint,
        confirmLabel: type === 'dirtyClose' && options.confirmLabel ? options.confirmLabel : translate(keys[type]),
        denyLabel: options.denyLabel || translate('g.no'), cancelLabel: translate('g.cancel'),
        ...(type === 'overwriteBlueprint' ? { checkboxLabel: translate('missingModelsDialog.doNotAskAgain') } : {}),
    });
    if (type === 'overwriteBlueprint' && answer.value === true && answer.checkboxChecked) {
        const { app } = await import('/scripts/app.js');
        await app.ui.settings.setSettingValueAsync('Comfy.Workflow.WarnBlueprintOverwrite', false);
    }
    return answer.value;
}
