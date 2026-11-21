# Third-party software

- ComfyUI (Comfy Org and contributors): GPL-3.0-or-later. The full corresponding source is in this fork and each release's source archive. Upstream: https://github.com/Comfy-Org/ComfyUI. `LICENSE` retains the upstream license.
- Desktop OTA modules and local account broker protocol adapted from OneYes Canvas (basketikun and contributors): MIT. The complete notice is in `docs/CANVAS-MIT-LICENSE.txt`. Source: https://github.com/Pan-chongyu/oneyes-infinite-canvas. The product name, endpoints and signing identity are separate.
- ComfyUI application logos: Comfy Org, from [Comfy Desktop assets](https://github.com/Comfy-Org/Comfy-Desktop/tree/67b362d16f8d398958b63cae332535655c57fe32/assets). `icon.png` and `icon-macos.png` retain the upstream PNGs; ICO and ICNS are resized containers of those assets. Monochrome tray templates are derived from the foreground of `icon.png` on transparent backgrounds. Distributed under the AGPL-3.0-or-later option in `docs/COMFY-DESKTOP-LICENSE.txt`. These assets identify ComfyUI; this fork remains an independent OneYes integration.
- uv 0.13.9 (Astral): MIT / Apache-2.0. Verified per-platform binaries from https://github.com/astral-sh/uv; source https://github.com/astral-sh/uv/tree/0.13.9.
- Electron: MIT; Chromium and other notices are bundled by Electron. electron-builder, electron-updater and semver: MIT. bsdiff-wasm includes its own notices in node_modules. ComfyUI Python dependencies retain their individual licenses and are installed by uv in an isolated local environment.

OneYes ComfyUI is a community fork, not an official Comfy Org distribution. Logos identify their respective products. No private OneYes Desktop sources or API credentials are distributed here.
