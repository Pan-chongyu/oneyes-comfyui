from getpass import getpass

from .storage import Vault


if __name__ == "__main__":
    value = getpass("OneYes API Key（输入不回显）: ").strip()
    if value:
        Vault().save({"default": value})
        print("已保存到本机加密存储；可启动 ComfyUI 并使用 OneYes 节点。")
