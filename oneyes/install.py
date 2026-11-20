import shutil
from pathlib import Path

if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    destination = root / 'custom_nodes' / 'oneyes'
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / 'oneyes' / 'custom_node.py', destination / '__init__.py')
    shutil.copytree(root / 'oneyes' / 'web', destination / 'web', dirs_exist_ok=True)
    print('OneYes nodes installed. Start ComfyUI and search for OneYes.')
