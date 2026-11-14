# VodSync

VodSync is a local-first browser tool for reviewing two to six point-of-view recordings on one synchronized timeline. It estimates timing from shared audio and screen sequences, then lets the reviewer inspect and correct each offset.

VodSync is experimental. Automatic timing can be wrong, especially when recordings have little shared audio, long gaps, heavy edits, or unsupported codecs. Review the result and adjust timing before relying on it.

## Privacy model

- Recordings remain on the device and are read through browser `File` and `Blob` APIs.
- There is no upload path, account, analytics, telemetry, server-side media processing, or persistent media copy.
- Selected filenames appear only in the local page while the session is open.
- Temporary media URLs, workers, decoded samples, and playback elements are released when the player closes.
- The production application loads its code and assets from the same site. It makes no media request to an external service.

## Requirements

- Node.js 22.12 or newer for development and builds.
- A current Chromium-based browser with WebCodecs, module workers, and native playback support for the selected recordings.

Browser codec support varies by operating system. MP4, WebM, and MKV files are accepted, but a container or codec that the browser cannot decode will be rejected locally.

## Develop and build

```text
npm ci
npm run dev
```

Run the retained checks and create the production bundle with:

```text
npm run check
npm run build
npm run verify
npm run preview
```

The application is configured for the canonical `/tools/VodSync/` base path. `npm run build` writes static output to `dist/`; source maps are disabled. The production build inserts a restrictive content security policy into `index.html` because GitHub Pages does not support repository-defined response headers, and stamps the hashed MediaBunny worker filename into `open-source.html`. `npm run verify` builds and then checks `dist/`: the notice names the emitted worker, the worker keeps its MPL notice, ids are unique, internal links resolve, and nothing loads from another origin. CI runs `npm run verify` on every push to `main` and every pull request.

## Use

1. Choose or drop two to six recordings from the same event.
2. Select **Start Sync**. No analysis starts before this explicit action.
3. Review the synchronized Focus or Grid view.
4. Open **Adjust timing** if an estimate needs correction, then apply a numeric offset or nudge it in small steps.
5. Exit the player to release its local resources.

## Licence and third-party software

VodSync source code is copyright 2026 Enzo Mutiso and is licensed under the [Apache License 2.0](LICENSE). The project `NOTICE` records authorship attribution.

VodSync uses MediaBunny 1.50.8 under the Mozilla Public License 2.0. MediaBunny is not relicensed under Apache 2.0. Exact dependency attribution, licence terms, shipped-code boundaries, checksums, and corresponding-source availability are documented in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). The exact npm artifact and a complete corresponding-source archive, including the upstream `shared/` TypeScript omitted from that npm artifact, are included under `third_party/` and deployed beside the application.

## Public links

- Tool index: <https://enzo.mutiso.ca/tools/>
- Application: <https://enzo.mutiso.ca/tools/VodSync/>
- Source: <https://github.com/emutiso/VodSync>
