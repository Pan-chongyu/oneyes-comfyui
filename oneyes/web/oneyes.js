import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

async function request(path, options) {
    const response = await api.fetchApi(`/oneyes/${path}`, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "连接失败，请检查设置后重试");
    return data;
}

function dialog(title) {
    const panel = document.createElement("dialog");
    panel.className = "oneyes-dialog";
    const heading = document.createElement("h2"); heading.textContent = title;
    const close = document.createElement("button"); close.textContent = "关闭";
    close.className = "oneyes-close"; close.onclick = () => panel.close();
    panel.append(heading, close);
    panel.addEventListener("close", () => panel.remove());
    document.body.append(panel); panel.showModal();
    return panel;
}

async function showSettings() {
    if (window.oneYesDesktop) return window.oneYesDesktop.openSettings();
    const panel = dialog("OneYes 设置");
    const note = document.createElement("p"); note.textContent = "Key 仅保存在本机，不写入工作流。图片与文字可使用不同分组的 Key。"; panel.append(note);
    const fields = {};
    for (const [name, label] of [["default", "默认 Key"], ["image", "图片 Key（选填）"], ["text", "文字 Key（选填）"]]) {
        const row = document.createElement("label"); row.textContent = label;
        const input = document.createElement("input"); input.type = "password"; input.autocomplete = "off"; input.placeholder = "留空保留已有 Key";
        row.append(input); panel.append(row); fields[name] = input;
    }
    const status = document.createElement("p"); status.setAttribute("role", "status");
    const save = document.createElement("button"); save.textContent = "保存 Key";
    save.onclick = async () => {
        try {
            const values = Object.fromEntries(Object.entries(fields).filter(([, input]) => input.value.trim()).map(([name, input]) => [name, input.value.trim()]));
            await request("settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
            Object.values(fields).forEach(input => input.value = ""); status.textContent = "已保存，可选择模型并运行节点";
        } catch (error) { status.textContent = error.message; }
    };
    panel.append(save, status);
}

async function chooseModel(node) {
    const panel = dialog("选择 OneYes 模型");
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "搜索完整模型名称";
    const list = document.createElement("div"); list.className = "oneyes-models";
    const status = document.createElement("p"); status.textContent = "正在读取当前 Key 的可用模型…"; status.setAttribute("role", "status");
    panel.append(search, status, list);
    try {
        const { models } = await request(`models/${node.comfyClass === "OneYesText" ? "text" : "image"}`);
        status.textContent = `${models.length} 个可用模型，请选择支持当前节点接口的模型`;
        const render = () => {
            list.replaceChildren();
            for (const model of models.filter(value => value.toLowerCase().includes(search.value.toLowerCase()))) {
                const button = document.createElement("button"); button.textContent = model;
                button.onclick = () => { const widget = node.widgets.find(item => item.name === "model"); widget.value = model; widget.callback?.(model); app.graph.setDirtyCanvas(true); panel.close(); };
                list.append(button);
            }
        };
        search.oninput = render; render(); search.focus();
    } catch (error) { status.textContent = error.message; }
}

app.registerExtension({
    name: "OneYes.Integration",
    async setup() {
        const style = document.createElement("style");
        style.textContent = `.oneyes-dialog{background:var(--comfy-menu-bg,#202024);color:var(--input-text,#eee);border:1px solid #6666;border-radius:14px;padding:24px;width:min(520px,90vw);max-height:80vh}.oneyes-dialog::backdrop{background:#0009}.oneyes-dialog h2{font-size:19px;margin:0 70px 20px 0}.oneyes-dialog label{display:block;margin:16px 0 6px}.oneyes-dialog input{display:block;width:100%;box-sizing:border-box;margin:7px 0;padding:10px;background:var(--comfy-input-bg,#303035);color:inherit;border:1px solid #8886;border-radius:7px}.oneyes-dialog button{padding:9px 13px;border-radius:7px;cursor:pointer}.oneyes-close{position:absolute;right:20px;top:18px}.oneyes-models{display:grid;gap:5px;max-height:48vh;overflow:auto}.oneyes-models button{text-align:left;overflow-wrap:anywhere}.oneyes-dialog p{line-height:1.6;font-size:13px}`;
        document.head.append(style);
        app.ui.settings.addSetting({id:"OneYes.Settings", name:"OneYes API Key", type: () => { const button = document.createElement("button"); button.textContent="打开 OneYes 设置"; button.onclick=showSettings; return button; }});
    },
    nodeCreated(node) {
        if (!["OneYesImage", "OneYesImageEdit", "OneYesText"].includes(node.comfyClass)) return;
        node.addWidget("button", "选择 OneYes 模型", null, () => chooseModel(node), { serialize: false });
        node.addWidget("button", "OneYes 设置", null, showSettings, { serialize: false });
    },
});
