# Third-party notices

Claude Office is MIT licensed (see `LICENSE`). The desktop builds bundle the
following third-party software and assets.

## 3D assets (frontend static export)

The full per-asset list with authors and source links is generated into
`static/assets/NOTICE.md` (from `frontend/scripts/fetch-assets.ts` and
`fetch-materials.ts`). Summary:

| Assets | Source | License |
| --- | --- | --- |
| Office models, HDRIs | [Poly Haven](https://polyhaven.com) | CC0 1.0 |
| PBR materials | [ambientCG](https://ambientcg.com) | CC0 1.0 |
| Characters and animations | [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) | MIT, Copyright (c) 2020 Microsoft (`static/assets/characters/LICENSE-ROCKETBOX.md`) |
| MPFB cast (when built with `tools/mpfb`) | MPFB2 / MakeHuman CC0 assets, Quaternius UAL, Mesh2Motion | CC0 1.0 |
| Havok physics (`HavokPhysics.wasm`) | [`@babylonjs/havok`](https://www.npmjs.com/package/@babylonjs/havok) | MIT |
| Basis Universal KTX2 transcoder (`public/ktx2/*.js`, `*.wasm`; shipped) | [Basis Universal](https://github.com/BinomialLLC/basis_universal) via [`@babylonjs/ktx2decoder`](https://www.npmjs.com/package/@babylonjs/ktx2decoder) 9.31.3 | Apache-2.0 |
| KTX-Software `ktx` CLI 4.4.2 (build-time texture encoder only; downloaded to `node_modules/.cache`, not redistributed or shipped) | [KhronosGroup/KTX-Software](https://github.com/KhronosGroup/KTX-Software) | Apache-2.0 |

Bring-your-own character packs (Character Creator, MetaHuman, …) are never
bundled; release builds are made from a clean checkout.

## Desktop shell

- [Electron](https://www.electronjs.org) (MIT) and Chromium (BSD-style and
  others; full text in `LICENSES.chromium.html` next to the executable).
- [electron-updater](https://github.com/electron-userland/electron-builder) (MIT).

## Frontend libraries

Babylon.js (Apache-2.0), React (MIT), Next.js (MIT), PixiJS (MIT), Zustand
(MIT), XState (MIT), lucide-react (ISC), and others listed in
`frontend/package.json`, each under its own license.

## Backend and hook (frozen Python runtimes)

Python (PSF License), FastAPI (MIT), Starlette (BSD-3-Clause), Uvicorn
(BSD-3-Clause), Pydantic (MIT), SQLAlchemy (MIT), aiosqlite (MIT), websockets
(BSD-3-Clause), httpx (BSD-3-Clause), Rich (MIT), greenlet (MIT/PSF),
defusedxml (PSF), bundled with [PyInstaller](https://pyinstaller.org)
(GPL-2.0 with a bootloader exception that permits distributing the frozen
applications under their own license).
