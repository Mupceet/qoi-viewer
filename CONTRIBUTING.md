# Contributing to QOI Viewer

Thanks for your interest! This guide will help you understand the codebase and start contributing.

## Development Setup

**Prerequisites:** [Node.js](https://nodejs.org/) and [Visual Studio Code](https://code.visualstudio.com/).

```bash
git clone https://github.com/Mupceet/qoi-viewer.git
cd qoi-viewer
npm install
```

**Development workflow:**

- `npm run watch` — start TypeScript watch mode for live recompilation
- Press **F5** in VS Code to launch the Extension Development Host with the extension loaded
- `vsce package` — clean, compile, and package a `.vsix` file for distribution

## Project Architecture

The extension uses VS Code's [Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors). It has two isolated parts that communicate via `postMessage`:

### Extension Host (`src/`)

Runs in a Node.js process. Responsible for:

- Reading and decoding QOI files
- Watching files for changes (auto-refresh on edit, close on delete)
- Managing status bar entries (image info, zoom level)
- Encoding and saving PNG exports

### Webview (`media/`)

Runs in an isolated browser sandbox. Responsible for:

- Rendering decoded pixels onto an HTML Canvas
- Handling user interaction: mouse-wheel zoom, drag-to-pan
- Assembling chunked pixel data for large images
- Sending export requests back to the extension host

### Data Flow

**Opening a QOI file:**

```
User opens .qoi file
  → preview.ts reads file via VS Code filesystem API
  → decodeQoi.ts decodes QOI → RGBA Uint8ClampedArray
  → preview.ts sends pixels to webview:
      ≤ 512 KB: single postMessage with Transferable ArrayBuffer
      > 512 KB: chunked messages (imageInit → imageChunk... → imageDone)
  → editor.js renders pixels on <canvas>
```

**Exporting as PNG — two paths:**

1. **From the preview editor** (right-click or command palette):
   `editor.js` calls `canvas.toDataURL('image/png')` → sends base64 data URL to `preview.ts` → writes to disk.

2. **From the Explorer context menu** (without opening the file):
   `preview.ts` decodes the QOI file → `encodePng.ts` encodes pixels as PNG using Node.js `zlib` → writes to disk.

## Module Guide

### `src/extension.ts`

Entry point. Activates the extension, creates status bar entries, registers the custom editor provider and commands. Wires everything together.

### `src/preview.ts`

Core of the extension. Implements `QoiEditorProvider` (VS Code `CustomReadonlyEditorProvider`):

- Manages webview lifecycle and tracks the active preview panel
- Reads QOI files, calls the decoder, sends pixel data to the webview
- Handles chunked transfer for images larger than 512 KB
- Coordinates PNG export from both webview and Explorer paths
- Sets up `FileSystemWatcher` for auto-refresh and auto-close

### `src/decodeQoi.ts`

Pure TypeScript QOI decoder. Takes a `Uint8Array` of raw file bytes, returns `{ pixels, width, height, channels, colorspace }`. Always outputs RGBA as `Uint8ClampedArray`, even for RGB-encoded files. Validates the QOI header and enforces a 400M pixel limit.

### `src/encodePng.ts`

Minimal PNG encoder using Node.js built-in `zlib`. Constructs a valid PNG file (signature, IHDR, IDAT with deflate-compressed scanlines, IEND) with CRC32 checksums. Zero external dependencies.

### `src/dispose.ts`

Provides a `Disposable` base class with an `_register()` pattern for managing lifecycle resources. Includes `disposeAll()` for cleaning up arrays of disposables.

### `src/ownedStatusBarEntry.ts`

Abstract base class for status bar entries that belong to a specific preview. Manages showing/hiding based on which preview is active.

### `src/infoStatusBarEntry.ts`

Status bar entry showing image dimensions and file size (e.g., `1920 x 1080 | 1.2 MB`).

### `src/zoomStatusBarEntry.ts`

Status bar entry showing current zoom level. Clicking it opens a QuickPick with preset zoom levels and a "Fit to Window" option.

### `media/editor.js`

Webview script. Handles:

- Rendering pixel data onto the canvas (single transfer and chunked assembly)
- Mouse-wheel zoom centered on cursor position
- Click-and-drag panning
- Right-click context menu for PNG export
- Sending `info` and `zoom` messages back to the extension host

## QOI Format Primer

QOI (Quite OK Image) is a fast, lossless image format. Key structure:

- **Header** (14 bytes): magic bytes `qoif`, 32-bit width, 32-bit height, 1-byte channels (3 or 4), 1-byte colorspace (sRGB or linear)
- **Pixel data**: a sequence of opcodes that encode pixels relative to the previous pixel:
  - **QOI_OP_INDEX** — reference a previously seen pixel from a 64-slot hash table
  - **QOI_OP_DIFF** — small delta (-2..+1) per channel
  - **QOI_OP_LUMA** — larger delta with separate green and red/blue differential
  - **QOI_OP_RUN** — run-length encoding of up to 62 consecutive identical pixels
  - **QOI_OP_RGB** — absolute RGB triple
  - **QOI_OP_RGBA** — absolute RGBA quad
- **End marker** (8 bytes): `0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x01`

Full spec: [qoiformat.org](https://qoiformat.org/)

## Debugging

1. **Launch Extension Development Host:** Open this project in VS Code, press **F5**. A new VS Code window opens with the extension loaded. Open a `.qoi` file to test.

2. **Webview DevTools:** While the QOI preview is focused, press `Ctrl+Shift+I` (or `Cmd+Option+I` on macOS) to open DevTools for the webview. Use the Console tab to see webview logs (prefixed `[QOI Viewer webview]`).

3. **Extension Host logs:** In the development VS Code window, open the Output panel and select "Log (Extension Host)" to see host-side logs (prefixed `[QOI Viewer]`).

4. **Rebuild after changes:** If `npm run watch` is running, TypeScript recompiles on save. Reload the Extension Development Host window (`Ctrl+R`) to pick up changes.

## Submitting Changes

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Ensure `npm run compile` passes with no errors
5. Open a Pull Request

Follow the existing code style. Keep changes focused — one concern per PR.

## Building from Source

```bash
git clone https://github.com/Mupceet/qoi-viewer.git
cd qoi-viewer
npm install
npx vsce package
```

This produces `qoi-viewer-<version>.vsix`. Install it manually in VS Code via the Extensions panel → "..." → "Install from VSIX...".

## License

MIT — see [LICENSE](LICENSE).
