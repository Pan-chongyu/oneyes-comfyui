const bridge = window.oneYesDesktop;
const $ = id => document.getElementById(id);
let current, modelValues = [];
const message = value => $('message').textContent = value;
const action = (id, callback) => $(id).addEventListener('click', async () => { $(id).disabled = true; message(''); try { await callback(); } catch (error) { message(error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); } finally { $(id).disabled = false; } });
for (const button of document.querySelectorAll('nav button')) button.onclick = () => {
    document.querySelectorAll('nav button').forEach(item => item.classList.toggle('selected', item === button));
    document.querySelectorAll('.page').forEach(page => page.hidden = page.id !== button.dataset.tab);
    message('');
};
function configured(values) { for (const name of ['default', 'image', 'text']) $(name + '-configured').textContent = values[name] ? '已保存' : ''; }
function render(state) {
    current = state;
    $('version').textContent = 'v' + state.version;
    $('update-version').textContent = `当前版本 v${state.version} · ${state.arch}`;
    if (state.platform === 'darwin') document.body.classList.add('macos');
    if (state.configured) configured(state.configured);
    const runtime = state.runtime, busy = ['installing', 'starting'].includes(runtime.status);
    $('runtime-label').textContent = ({ idle: '准备开始', installing: runtime.phase, starting: '正在启动画布', ready: '画布已启动', error: '启动未完成' })[runtime.status];
    $('runtime-detail').textContent = runtime.message || '首次启动自动配置独立运行环境，需要联网下载依赖；之后复用本机环境。';
    $('runtime-dot').className = `status-dot ${busy ? 'busy' : runtime.status}`;
    $('runtime-progress').hidden = !busy;
    $('launch').disabled = busy;
    $('launch').textContent = busy ? '正在准备…' : runtime.status === 'ready' ? '打开画布' : runtime.status === 'error' ? '重试启动' : '安装依赖并打开画布';
    const update = state.update;
    $('update-label').textContent = ({ idle: '尚未检查更新', checking: '正在检查更新…', downloading: `正在下载 v${update.version} · ${Math.round(update.progress)}%`, ready: `v${update.version} 已准备好`, current: '当前已是最新版本', error: '更新未完成', installing: '正在安装并重新打开…' })[update.status] || update.status;
    $('update-detail').textContent = update.error || update.notes || '更新清单采用独立 Ed25519 签名，下载后校验 SHA-256。';
    $('update-progress').hidden = !['downloading', 'installing'].includes(update.status);
    $('update-progress').value = update.progress;
    $('install-update').hidden = update.status !== 'ready';
    $('check-update').disabled = ['checking', 'downloading', 'installing'].includes(update.status) || !update.supported;
}
$('key-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
        const changes = {};
        for (const name of ['default', 'image', 'text']) if ($(name + '-key').value.trim()) changes[name] = $(name + '-key').value.trim();
        if (!Object.keys(changes).length) { message('请填写要保存的 Key；留空会保留现有设置。'); return; }
        configured(await bridge.saveKeys(changes));
        for (const name of ['default', 'image', 'text']) $(name + '-key').value = '';
        message('Key 已保存。可以打开画布使用 OneYes 节点。');
    } catch (error) { message(error.message); } finally { button.disabled = false; }
});
action('clear-keys', async () => { if (window.confirm('清除本机已保存的全部 OneYes Key？原任务取回需要重新填写原 Key。')) { configured(await bridge.saveKeys({default:'',image:'',text:''})); message('已清除本机 Key'); } });
$('toggle-key').onclick = () => { const hidden = $('default-key').type === 'password'; $('default-key').type = hidden ? 'text' : 'password'; $('toggle-key').textContent = hidden ? '隐藏' : '显示'; };
action('launch', () => bridge.launch());
action('open-keys', () => bridge.openKeys());
action('open-data', () => bridge.openData());
action('check-update', () => bridge.checkUpdate());
action('install-update', () => bridge.installUpdate());
function renderModels() {
    $('model-list').replaceChildren();
    const values = modelValues.filter(value => value.toLowerCase().includes($('model-search').value.toLowerCase()));
    if (!values.length) $('model-list').textContent = '没有匹配的模型，请检查 Key 分组或搜索条件。';
    for (const model of values) { const button = document.createElement('button'); button.textContent = model; button.onclick = async () => { await navigator.clipboard.writeText(model); message('已复制模型 ID，可粘贴到节点的模型输入框。'); }; $('model-list').append(button); }
}
action('refresh-models', async () => { const data = await bridge.models($('model-profile').value); modelValues = data.models; renderModels(); message(`已读取 ${modelValues.length} 个模型`); });
$('model-search').oninput = renderModels;
action('refresh-tasks', async () => {
    const { tasks } = await bridge.tasks(); $('task-list').replaceChildren();
    if (!tasks.length) $('task-list').textContent = '还没有图片任务。在画布中运行 OneYes 图片节点后，会在这里保存记录。';
    const labels = {submitting:'提交结果待核对',unknown:'提交结果待核对',processing:'生成中，可取回',completed:'已完成',failed:'原任务失败',cancelled:'已取消'};
    for (const task of tasks) {
        const row = document.createElement('div'); row.className = 'task-item';
        const title = document.createElement('strong'); title.textContent = `${task.model} · ${labels[task.status] || task.status}`;
        const details = document.createElement('p'); details.textContent = `${new Date(task.created).toLocaleString()}　${task.remote_id || '未收到服务端回执，请先在官网核对'} `;
        const copy = document.createElement('button'); copy.className='quiet'; copy.textContent='复制本地任务编号'; copy.onclick=async () => { await navigator.clipboard.writeText(task.id); message('已复制，粘贴到“取回原图片任务”节点即可。'); };
        row.append(title, details, copy); $('task-list').append(row);
    }
});
bridge.onState(render);
bridge.state().then(render).catch(error => message(error.message));
