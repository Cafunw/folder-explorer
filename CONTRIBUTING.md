# Contributing

Thanks for helping! Bug reports, ideas, translations and pull requests are all welcome. For a bigger change, open an issue or a discussion first so we can agree on the approach.

## Getting started

You need Node.js, Rust (stable, MSVC toolchain) and Windows 11.

```bash
npm install
npm run tauri dev
```

`npm run tauri dev` starts the app from source; interface changes reload instantly and Rust changes rebuild it. `npm run dev` previews the interface in a browser with sample data, without Windows integration. Dev builds share their settings folder (`%APPDATA%\Folder Explorer`) with an installed copy.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes how the app is put together, every command between the interface and Rust, and the file formats.

## Before you open a pull request

Run the same checks as CI:

```bash
npm run typecheck
npm run lint
npm test
cd src-tauri
cargo test --lib
cargo clippy --lib --tests -- -D warnings
```

- **Windows is never modified.** The app hides Explorer's icon list while it runs and changes nothing else in Windows, apart from the opt-in entries described in the architecture doc. Changes that write to the registry, hook Explorer or move files without the user asking won't be merged.
- **Interface text** lives in `src/i18n.en.ts` (English) and `src/i18n.ts` (Turkish) with the same keys; a test fails when one is missing or left untranslated. Text shown from Rust goes through `lang::t(en, tr)`.
- **Keep it focused.** One change per pull request, with tests for new logic. Commit messages start with an imperative sentence ("Keep the selection when…").

## Translations

A new language needs its dictionary next to `src/i18n.en.ts`, an entry in the `Language` type and the language picker, and its strings in `src-tauri/src/lang.rs` and the installer hooks. Open an issue first if you'd like to take one on.
