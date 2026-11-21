const bridge = window.oneYesDesktop;
function render({ runtime }) {
    document.getElementById('status').textContent = runtime.status === 'error' ? runtime.message : runtime.message || '正在打开画布…';
    document.getElementById('actions').hidden = runtime.status !== 'error';
    document.getElementById('spinner').hidden = runtime.status === 'error';
}
document.getElementById('retry').onclick = () => bridge.launch().catch(() => {});
document.getElementById('data').onclick = () => bridge.openData();
bridge.onState(render);
bridge.state().then(render);
