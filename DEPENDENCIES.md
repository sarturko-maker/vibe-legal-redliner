# Bundled Dependencies

All third-party code shipped with the Vibe Legal Chrome Extension. Every file is bundled locally — nothing is fetched from a CDN at runtime.

## Pyodide Runtime (v0.26.4)

Source: https://github.com/pyodide/pyodide/releases/tag/0.26.4

| File | SHA-256 |
|------|---------|
| `pyodide/pyodide.js` | `c0069107621d5b942a659e737a12e774cc0451feaa2256f475d72e071d844ec7` |
| `pyodide/pyodide.asm.js` | `919560652ed3dad3707cb3a394785da1e046fb13dc0defa162058ff230cb7eed` |
| `pyodide/pyodide.asm.wasm` | `b7e66a19427a55010ac3367c1b6c64b893f9826f783412945fdf0c3337f3bc94` |
| `pyodide/python_stdlib.zip` | `72894522b791858b9d613ac786b951d8b5094035dcf376313ea24a466810f336` |
| `pyodide/pyodide-lock.json` | `cd50b49de944c579045e122fe8628b31f9ce446379f032f36c05e273d38766e0` |

## Python Wheels

Installed into Pyodide via `micropip.install()` at startup. All `.whl` files are in the `pyodide/` directory.

| Package | Version | Source | SHA-256 |
|---------|---------|--------|---------|
| micropip | 0.6.0 | [PyPI](https://pypi.org/project/micropip/0.6.0/) | `d97c0c01748ddbc52a19944c6a6788c6a8969ed13158c06bc63c6eb02779cd98` |
| typing_extensions | 4.11.0 | [PyPI](https://pypi.org/project/typing-extensions/4.11.0/) | `696ecd97bd0abc88fc25d376ac06f4233ab16bba3e992c4b37bbc2715240d4e8` |
| annotated_types | 0.6.0 | [PyPI](https://pypi.org/project/annotated-types/0.6.0/) | `50f2adc38958cbac4c343806a8d7554bd987098e332ea5a796c642018455af2a` |
| packaging | 23.2 | [PyPI](https://pypi.org/project/packaging/23.2/) | `3c30fe6689a35520f2040f4963eae8dbdf6aaa8e326674a13bca3f11514c674a` |
| pydantic_core | 2.18.1 | [PyPI](https://pypi.org/project/pydantic-core/2.18.1/) | `f85156f928fbed235b783546dbe6fb38ca72cdc72e48aa8f841ea435c0fb2166` |
| pydantic | 2.7.0 | [PyPI](https://pypi.org/project/pydantic/2.7.0/) | `750ccf9a0b0b9d8ddb555430510d444c1b00f121e51aa94e3b18a82af4d73a99` |
| lxml | 5.2.1 | [PyPI](https://pypi.org/project/lxml/5.2.1/) | `162c1a8c58fa7da34c2c492b7a572f8d604318d9708f6cd8c3968bfa5fe8a08b` |
| python-docx | 1.2.0 | [PyPI](https://pypi.org/project/python-docx/1.2.0/) | `3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7` |
| diff-match-patch | 20241021 | [PyPI](https://pypi.org/project/diff-match-patch/20241021/) | `93cea333fb8b2bc0d181b0de5e16df50dd344ce64828226bda07728818936782` |
| structlog | 25.5.0 | [PyPI](https://pypi.org/project/structlog/25.5.0/) | `a8453e9b9e636ec59bd9e79bbd4a72f025981b3ba0f5837aebf48f02f37a7f9f` |

## JavaScript Libraries

| Library | Version | Source | SHA-256 |
|---------|---------|--------|---------|
| JSZip | 3.10.1 | [GitHub](https://github.com/Stuk/jszip/releases/tag/v3.10.1) | `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e` |

## Python Engine

| Component | Version | Source | Notes |
|-----------|---------|--------|-------|
| Adeu | 0.6.7 | [GitHub](https://github.com/dealfluence/adeu) | Loaded into Pyodide virtual filesystem at runtime. Version pinned in `python/adeu/VERSION`. |

## Verification

To verify hashes, run from the `vibe-legal-extension/` directory:

```bash
sha256sum pyodide/pyodide.js pyodide/pyodide.asm.js pyodide/pyodide.asm.wasm \
  pyodide/python_stdlib.zip pyodide/pyodide-lock.json \
  pyodide/*.whl src/lib/jszip.min.js
```

Compare the output against the hashes in this file.

## Update Procedure

These instructions cover updating the dependencies bundled _inside_ the extension. The Chrome Web Store handles extension auto-updates to end users — this procedure is for maintainers preparing a new version for submission.

After any update, re-run the verification command above and update both `DEPENDENCIES.md` and `SBOM.md` with the new hashes.

### 1. Pyodide Runtime

1. Download the new release from https://github.com/pyodide/pyodide/releases (choose the `pyodide-x.y.z.tar.bz2` bundle).
2. Extract and replace the following files in `vibe-legal-extension/pyodide/`:
   - `pyodide.js`
   - `pyodide.asm.js`
   - `pyodide.asm.wasm`
   - `python_stdlib.zip`
   - `pyodide-lock.json`
3. Check the Pyodide changelog for breaking API changes. The extension loads Pyodide in `src/offscreen.js` via `loadPyodide({ indexURL: ... })` — verify this still works.
4. **Important:** A Pyodide major version bump may change the Python version and break binary compatibility with the bundled `.whl` files. If the Pyodide release upgrades CPython (e.g., cp312 to cp313), all platform-specific wheels (`*-pyodide_*_wasm32.whl`) must also be replaced with builds targeting the new version. See "Python Wheels" below.
5. Compute new SHA-256 hashes and update `DEPENDENCIES.md` and `SBOM.md`.

### 2. Python Wheels

Wheels are in `vibe-legal-extension/pyodide/` and installed via `micropip.install()` at startup.

**Pure-Python wheels** (filename contains `py3-none-any`): download from PyPI as normal.

```
typing_extensions, annotated_types, packaging, pydantic,
python-docx, diff-match-patch, structlog, micropip
```

**Platform-specific wheels** (filename contains `pyodide_*_wasm32`): these must match the bundled Pyodide version. Download from the Pyodide release assets or build from source using `pyodide build`.

```
lxml, pydantic_core
```

To update a wheel:

1. Download the new `.whl` file from PyPI (pure-Python) or the Pyodide release (platform-specific).
2. For platform-specific wheels, ensure the filename's `cpXYZ` tag and `pyodide_YYYY_N` tag match the bundled Pyodide version. For example, `lxml-5.2.1-cp312-cp312-pyodide_2024_0_wasm32.whl` requires Pyodide 0.26.x with CPython 3.12.
3. Replace the old `.whl` in `vibe-legal-extension/pyodide/`.
4. Update the filename in the `packages` array in `src/offscreen.js` (`initPyodide()` function, around line 65).
5. Compute the new SHA-256 hash and update `DEPENDENCIES.md` and `SBOM.md`.
6. Test that the extension loads without import errors (inspect the offscreen document console).

### 3. JSZip

1. Download the new release from https://github.com/Stuk/jszip/releases.
2. Replace `vibe-legal-extension/src/lib/jszip.min.js` with the minified build (`dist/jszip.min.js` from the release).
3. JSZip is dual-licensed MIT/GPLv3. Confirm the new release still offers the MIT option.
4. Compute the new SHA-256 hash and update `DEPENDENCIES.md` and `SBOM.md`.

### 4. Adeu Engine

Adeu source files live in `vibe-legal-extension/python/adeu/` and are loaded into Pyodide's virtual filesystem at startup by `loadAdeuSource()` in `src/offscreen.js`.

To update from the upstream repository:

1. Clone or download the latest release from https://github.com/dealfluence/adeu.
2. Copy the source files into `vibe-legal-extension/python/adeu/`, preserving the directory structure (`redline/`, `utils/`).
3. Update `python/adeu/VERSION` with the new version number (check `pyproject.toml` in the upstream repo for the canonical version).
4. If new source files were added upstream, add them to the `files` array in `loadAdeuSource()` in `src/offscreen.js` and create any new directories in the `FS.mkdir()` block.
5. If Adeu added new Python dependencies, add the corresponding `.whl` files to `vibe-legal-extension/pyodide/` and the `packages` array in `initPyodide()`.
6. Test by inspecting the offscreen document console — it should log `Adeu engine vX.Y.Z` with the new version.
7. Update `DEPENDENCIES.md` and `SBOM.md` with the new version.
