# Software Bill of Materials (SBOM)

All third-party code bundled with the Vibe Legal Chrome Extension. Nothing is fetched from a CDN at runtime — every dependency listed here is shipped inside the extension package.

Generated: 2026-02-06

## JavaScript

| Component | Version | Licence | Source URL | SHA-256 |
|-----------|---------|---------|------------|---------|
| JSZip | 3.10.1 | MIT (dual-licensed MIT/GPLv3; used under MIT) | https://github.com/Stuk/jszip/releases/tag/v3.10.1 | `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e` |

## WebAssembly / Pyodide Runtime (v0.26.4)

| Component | Version | Licence | Source URL | SHA-256 |
|-----------|---------|---------|------------|---------|
| pyodide.js | 0.26.4 | MPL 2.0 | https://github.com/pyodide/pyodide/releases/tag/0.26.4 | `c0069107621d5b942a659e737a12e774cc0451feaa2256f475d72e071d844ec7` |
| pyodide.asm.js | 0.26.4 | MPL 2.0 | https://github.com/pyodide/pyodide/releases/tag/0.26.4 | `919560652ed3dad3707cb3a394785da1e046fb13dc0defa162058ff230cb7eed` |
| pyodide.asm.wasm | 0.26.4 | MPL 2.0 | https://github.com/pyodide/pyodide/releases/tag/0.26.4 | `b7e66a19427a55010ac3367c1b6c64b893f9826f783412945fdf0c3337f3bc94` |
| python_stdlib.zip | 0.26.4 | MPL 2.0 | https://github.com/pyodide/pyodide/releases/tag/0.26.4 | `72894522b791858b9d613ac786b951d8b5094035dcf376313ea24a466810f336` |
| pyodide-lock.json | 0.26.4 | MPL 2.0 | https://github.com/pyodide/pyodide/releases/tag/0.26.4 | `cd50b49de944c579045e122fe8628b31f9ce446379f032f36c05e273d38766e0` |

## Python Wheels

All `.whl` files reside in the `pyodide/` directory and are installed into Pyodide via `micropip.install()` at startup.

| Component | Version | Licence | Source URL | SHA-256 |
|-----------|---------|---------|------------|---------|
| micropip | 0.6.0 | MPL 2.0 | https://pypi.org/project/micropip/0.6.0/ | `d97c0c01748ddbc52a19944c6a6788c6a8969ed13158c06bc63c6eb02779cd98` |
| typing_extensions | 4.11.0 | PSF | https://pypi.org/project/typing-extensions/4.11.0/ | `696ecd97bd0abc88fc25d376ac06f4233ab16bba3e992c4b37bbc2715240d4e8` |
| annotated_types | 0.6.0 | MIT | https://pypi.org/project/annotated-types/0.6.0/ | `50f2adc38958cbac4c343806a8d7554bd987098e332ea5a796c642018455af2a` |
| packaging | 23.2 | BSD-2-Clause / Apache 2.0 | https://pypi.org/project/packaging/23.2/ | `3c30fe6689a35520f2040f4963eae8dbdf6aaa8e326674a13bca3f11514c674a` |
| pydantic_core | 2.18.1 | MIT | https://pypi.org/project/pydantic-core/2.18.1/ | `f85156f928fbed235b783546dbe6fb38ca72cdc72e48aa8f841ea435c0fb2166` |
| pydantic | 2.7.0 | MIT | https://pypi.org/project/pydantic/2.7.0/ | `750ccf9a0b0b9d8ddb555430510d444c1b00f121e51aa94e3b18a82af4d73a99` |
| lxml | 5.2.1 | BSD | https://pypi.org/project/lxml/5.2.1/ | `162c1a8c58fa7da34c2c492b7a572f8d604318d9708f6cd8c3968bfa5fe8a08b` |
| python-docx | 1.2.0 | MIT | https://pypi.org/project/python-docx/1.2.0/ | `3fd478f3250fbbbfd3b94fe1e985955737c145627498896a8a6bf81f4baf66c7` |
| diff-match-patch | 20241021 | Apache 2.0 | https://pypi.org/project/diff-match-patch/20241021/ | `93cea333fb8b2bc0d181b0de5e16df50dd344ce64828226bda07728818936782` |
| structlog | 25.5.0 | MIT / Apache 2.0 | https://pypi.org/project/structlog/25.5.0/ | `a8453e9b9e636ec59bd9e79bbd4a72f025981b3ba0f5837aebf48f02f37a7f9f` |

## Python Engine

| Component | Version | Licence | Source URL | SHA-256 |
|-----------|---------|---------|------------|---------|
| Adeu | 0.6.7 | MIT | https://github.com/dealfluence/adeu | N/A (source files, not a single binary — version pinned in `python/adeu/VERSION`) |

## Verification

To verify all hashes, run from the `vibe-legal-extension/` directory:

```bash
sha256sum \
  src/lib/jszip.min.js \
  pyodide/pyodide.js pyodide/pyodide.asm.js pyodide/pyodide.asm.wasm \
  pyodide/python_stdlib.zip pyodide/pyodide-lock.json \
  pyodide/*.whl
```

Compare the output against the SHA-256 column in the tables above.

## Licence Compatibility

The Vibe Legal Chrome Extension is licensed under **MIT**.

All bundled dependencies use licences that are compatible with MIT distribution:

| Licence | Components | Compatible with MIT? |
|---------|-----------|---------------------|
| MIT | JSZip, pydantic, pydantic_core, annotated_types, python-docx, Adeu | Yes — same licence |
| MIT / Apache 2.0 | structlog | Yes — both MIT and Apache 2.0 are permissive |
| Apache 2.0 | diff-match-patch | Yes — permissive; requires preservation of NOTICE file if present |
| BSD | lxml | Yes — permissive |
| BSD-2-Clause / Apache 2.0 | packaging | Yes — both are permissive |
| PSF | typing_extensions | Yes — permissive, similar to BSD |
| MPL 2.0 | Pyodide (runtime, micropip) | Yes — MPL 2.0 is file-level copyleft, compatible with MIT at the project level. MPL-licensed files retain their licence; the extension's own MIT code is unaffected. |

**Note on JSZip:** JSZip is dual-licensed under MIT and GPLv3. This extension uses JSZip exclusively under the **MIT** licence option to avoid GPLv3 copyleft obligations. The MIT licence terms apply.

No GPL-only, AGPL, SSPL, or other strongly copyleft dependencies are present.
