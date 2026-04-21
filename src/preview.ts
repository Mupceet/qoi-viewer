/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------
 *
 * QOI Custom Editor Provider for VS Code.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { decode as decodeQoi } from './decodeQoi';
import { encode as encodePng } from './encodePng';
import { InfoStatusBarEntry } from './infoStatusBarEntry';
import { Scale, ZoomStatusBarEntry } from './zoomStatusBarEntry';

const LOG_PREFIX = '[QOI Viewer]';
const CHUNK_THRESHOLD = 8 * 1024 * 1024; // 8MB: use chunked transfer above this size
const CHUNK_BYTE_LIMIT = 4 * 1024 * 1024; // 2MB per chunk
const CHUNK_DELAY_MS = 0; // Set > 0 (e.g. 200) to debug progressive rendering
const STREAM_THRESHOLD = 32 * 1024 * 1024; // 32MB: stream decode above this pixel size

type PreDecodeResult =
    | { success: true; image: { pixels: ArrayBuffer; width: number; height: number; channels: number; colorspace: number }; timing: { read: number; decode: number } }
    | { success: false; errorMessage: string; timing: { read: number; decode: number } };

export class QoiEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'qoi.previewEditor';

    private activeWebviewPanel: vscode.WebviewPanel | undefined;
    private activeUri: vscode.Uri | undefined;
    private decodeWorker: Worker | undefined;
    private readonly previews = new Map<vscode.WebviewPanel, { id: string; imageInfo: string | undefined; imageZoom: Scale | undefined }>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly infoStatusBarEntry: InfoStatusBarEntry,
        private readonly zoomStatusBarEntry: ZoomStatusBarEntry,
    ) {}

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.CustomDocument> {
        return { uri, dispose: () => {} };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        this.activeWebviewPanel = webviewPanel;
        this.activeUri = document.uri;

        let currentUri = document.uri;

        const previewId = `${Date.now()}-${Math.random().toString()}`;
        const previewState = { id: previewId, imageInfo: undefined as string | undefined, imageZoom: undefined as Scale | undefined };
        this.previews.set(webviewPanel, previewState);

        // Abort previous pre-decode by terminating the worker (instant)
        this.terminateWorker();

        // Start pre-decoding in parallel with webview init
        const resolveStart = Date.now();
        let preDecodeResult: PreDecodeResult | undefined;
        let streamState: {
            meta: { width: number; height: number; channels: number; colorspace: number; fileSize: number; uri: string; name: string };
            bufferedChunks: { offsetY: number; rows: number; data: ArrayBuffer }[];
            done: boolean;
        } | undefined;
        let streamRelay = false;

        // Decode ready promise: resolves when worker responds (full result or stream init)
        let decodeReadyResolve!: () => void;
        const decodeReady = new Promise<void>(r => { decodeReadyResolve = r; });

        // Worker message handler for both decode modes
        const worker = this.getOrCreateWorker();
        const onWorkerMessage = (msg: any) => {
            if (msg.type === 'result') {
                // Small file: full decode result
                worker.off('message', onWorkerMessage);
                const readMs = Date.now() - resolveStart - msg.timing.decode;
                if (msg.success) {
                    const timing = { read: readMs, decode: msg.timing.decode };
                    console.log(
                        `${LOG_PREFIX} preDecode done in ${timing.read + timing.decode}ms ` +
                        `(read=${timing.read}, decode=${timing.decode})`
                    );
                    preDecodeResult = { success: true, image: msg.image, timing };
                } else {
                    preDecodeResult = { success: false, errorMessage: msg.errorMessage, timing: { read: readMs, decode: msg.timing.decode } };
                }
                decodeReadyResolve();
            } else if (msg.type === 'streamInit') {
                // Large file: streaming mode started
                streamState = {
                    meta: {
                        width: msg.width, height: msg.height,
                        channels: msg.channels, colorspace: msg.colorspace,
                        fileSize: msg.fileSize,
                        uri: document.uri.toString(),
                        name: document.uri.path.split('/').pop() ?? '',
                    },
                    bufferedChunks: [],
                    done: false,
                };
                console.log(`${LOG_PREFIX} preDecode streaming: first chunk at ${msg.timing.firstChunk}ms`);
                decodeReadyResolve();
            } else if (msg.type === 'streamChunk') {
                if (streamRelay && this.activeWebviewPanel === webviewPanel) {
                    (webviewPanel.webview as any).postMessage(
                        { type: 'imageChunk', offsetY: msg.offsetY, rows: msg.rowCount, data: msg.data },
                        [msg.data]
                    );
                } else if (streamState) {
                    streamState.bufferedChunks.push({ offsetY: msg.offsetY, rows: msg.rowCount, data: msg.data });
                }
            } else if (msg.type === 'streamDone') {
                worker.off('message', onWorkerMessage);
                console.log(`${LOG_PREFIX} streamDecode complete: ${msg.timing.decode}ms, ${msg.chunkCount} chunks`);
                if (streamRelay && this.activeWebviewPanel === webviewPanel) {
                    webviewPanel.webview.postMessage({ type: 'imageDone' });
                    console.log(`${LOG_PREFIX} resolve→streamDone: ${Date.now() - resolveStart}ms`);
                } else if (streamState) {
                    streamState.done = true;
                }
            } else if (msg.type === 'streamError') {
                worker.off('message', onWorkerMessage);
                const errorMessage = msg.errorMessage;
                if (streamRelay && this.activeWebviewPanel === webviewPanel) {
                    webviewPanel.webview.postMessage({ type: 'error', message: errorMessage });
                } else {
                    // Store error as full-decode failure so ready handler can pick it up
                    preDecodeResult = { success: false, errorMessage, timing: { read: 0, decode: msg.timing.decode } };
                    if (!streamState) { decodeReadyResolve(); }
                }
            }
        };
        worker.on('message', onWorkerMessage);

        // Read file in main thread, then transfer to worker
        vscode.workspace.fs.readFile(document.uri).then(fileData => {
            const ab = fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength) as ArrayBuffer;
            worker.postMessage({ type: 'decode', data: ab, streamThreshold: STREAM_THRESHOLD }, [ab]);
        }, e => {
            worker.off('message', onWorkerMessage);
            const errorMessage = e instanceof Error ? e.message : String(e);
            preDecodeResult = { success: false, errorMessage, timing: { read: Date.now() - resolveStart, decode: 0 } };
            decodeReadyResolve();
        });

        // Track active panel
        webviewPanel.onDidChangeViewState(() => {
            if (webviewPanel.active) {
                this.activeWebviewPanel = webviewPanel;
                this.activeUri = currentUri;
                if (previewState.imageInfo) { this.infoStatusBarEntry.show(previewId, previewState.imageInfo); }
                if (previewState.imageZoom) { this.zoomStatusBarEntry.show(previewId, previewState.imageZoom); }
            } else if (this.activeWebviewPanel === webviewPanel) {
                this.infoStatusBarEntry.hide(previewId);
                this.zoomStatusBarEntry.hide(previewId);
            }
        });

        webviewPanel.onDidDispose(() => {
            this.previews.delete(webviewPanel);
            if (this.activeWebviewPanel === webviewPanel) {
                this.infoStatusBarEntry.hide(previewId);
                this.zoomStatusBarEntry.hide(previewId);
                this.activeWebviewPanel = undefined;
                this.activeUri = undefined;
            }
        });

        // Zoom status bar: user selects zoom level → forward to webview
        this.zoomStatusBarEntry.onDidChangeScale(e => {
            if (this.activeWebviewPanel) {
                this.activeWebviewPanel.webview.postMessage({ type: 'setScale', scale: e.scale });
            }
        });

        // File system watcher — auto-refresh on change, close on delete
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(document.uri, '*')
        );
        webviewPanel.onDidDispose(() => watcher.dispose());

        watcher.onDidChange(e => {
            if (e.toString() === currentUri.toString()) {
                this.sendImagePixels(webviewPanel, currentUri);
            }
        });

        watcher.onDidDelete(e => {
            if (e.toString() === document.uri.toString()) {
                webviewPanel.dispose();
            }
        });

        // Message handlers from webview
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.type) {
                case 'info':
                    previewState.imageInfo = message.value;
                    if (webviewPanel.active) {
                        this.infoStatusBarEntry.show(previewId, message.value);
                    }
                    break;
                case 'zoom':
                    previewState.imageZoom = message.value;
                    if (webviewPanel.active) {
                        this.zoomStatusBarEntry.show(previewId, message.value);
                    }
                    break;
                case 'showContextMenu': {
                    const saveLabel = vscode.l10n.t('Save as PNG');
                    const pick = await vscode.window.showQuickPick([saveLabel], { placeHolder: '' });
                    if (pick === saveLabel) {
                        this.exportPng();
                    }
                    break;
                }
                case 'exportPng':
                    await this.handleExportPng(message.dataUrl, currentUri);
                    break;
                case 'ready': {
                    const tReady = Date.now();
                    await decodeReady;

                    if (preDecodeResult) {
                        // Small file: full decode
                        if (preDecodeResult.success) {
                            const preDecodeMs = preDecodeResult.timing.read + preDecodeResult.timing.decode;
                            console.log(
                                `${LOG_PREFIX} preDecode was ready ` +
                                `${tReady - resolveStart - preDecodeMs}ms before webview`
                            );
                            this.sendDecodedImage(webviewPanel, document.uri, preDecodeResult);
                        } else {
                            webviewPanel.webview.postMessage({ type: 'error', message: preDecodeResult.errorMessage! });
                        }
                        console.log(`${LOG_PREFIX} resolve→send: ${Date.now() - resolveStart}ms`);
                    } else if (streamState) {
                        // Large file: flush buffered chunks, then relay future ones
                        console.log(`${LOG_PREFIX} webview ready, flushing ${streamState.bufferedChunks.length} buffered chunks`);
                        (webviewPanel.webview as any).postMessage({ type: 'imageInit', ...streamState.meta });
                        for (const chunk of streamState.bufferedChunks) {
                            (webviewPanel.webview as any).postMessage(
                                { type: 'imageChunk', offsetY: chunk.offsetY, rows: chunk.rows, data: chunk.data },
                                [chunk.data]
                            );
                        }
                        if (streamState.done) {
                            webviewPanel.webview.postMessage({ type: 'imageDone' });
                        }
                        streamRelay = true;
                        streamState.bufferedChunks = [];
                        console.log(`${LOG_PREFIX} resolve→streamStart: ${Date.now() - resolveStart}ms`);
                    }
                    break;
                }
            }
        });

        // Set up webview HTML
        const cssUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.css')
        );
        const jsUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'editor.js')
        );
        webviewPanel.webview.html = this.getHtml(cssUri, jsUri);
    }

    private getOrCreateWorker(): Worker {
        if (!this.decodeWorker) {
            const workerPath = path.join(__dirname, 'decodeWorker.js');
            this.decodeWorker = new Worker(workerPath);
        }
        return this.decodeWorker;
    }

    private terminateWorker(): void {
        if (this.decodeWorker) {
            this.decodeWorker.terminate();
            this.decodeWorker = undefined;
        }
    }

    /**
     * Send pre-decoded image pixels to webview (small files, full decode).
     */
    private sendDecodedImage(
        panel: vscode.WebviewPanel,
        uri: vscode.Uri,
        preDecoded: PreDecodeResult & { success: true }
    ): void {
        const { image, timing } = preDecoded;
        const pixels = new Uint8ClampedArray(image.pixels);
        const totalBytes = pixels.byteLength;
        const rowBytes = image.width * 4;
        const fileSize = image.width * image.height * 4; // approximate

        const meta = {
            width: image.width,
            height: image.height,
            channels: image.channels,
            colorspace: image.colorspace,
            fileSize,
            uri: uri.toString(),
            name: uri.path.split('/').pop() ?? '',
            timing,
        };

        if (totalBytes <= CHUNK_THRESHOLD) {
            const ab = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
            (panel.webview as any).postMessage(
                { type: 'image', ...meta, data: ab },
                [ab]
            );
        } else {
            (panel.webview as any).postMessage({ type: 'imageInit', ...meta });
            const maxRowsPerChunk = Math.max(1, Math.floor(CHUNK_BYTE_LIMIT / rowBytes));
            for (let offsetY = 0; offsetY < image.height; offsetY += maxRowsPerChunk) {
                const rows = Math.min(maxRowsPerChunk, image.height - offsetY);
                const start = offsetY * rowBytes;
                const end = start + rows * rowBytes;
                const slice = pixels.subarray(start, end);
                const ab = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
                (panel.webview as any).postMessage(
                    { type: 'imageChunk', offsetY, rows, data: ab },
                    [ab]
                );
            }
            panel.webview.postMessage({ type: 'imageDone' });
        }

        console.log(
            `${LOG_PREFIX} openImage ${image.width}x${image.height}: ` +
            `read=${timing.read}ms decode=${timing.decode}ms`
        );
    }

    /**
     * Decode QOI file and send pixels to webview (used by file watcher).
     * Uses Transferable ArrayBuffer — single message for small images,
     * chunked messages for large images.
     */
    private async sendImagePixels(
        panel: vscode.WebviewPanel,
        uri: vscode.Uri,
        isSwitch: boolean = false
    ): Promise<void> {
        try {
            const t0 = Date.now();
            const fileData = await vscode.workspace.fs.readFile(uri);
            const tRead = Date.now();
            const image = decodeQoi(new Uint8Array(fileData));
            const tDecode = Date.now();
            const timing = { read: tRead - t0, decode: tDecode - tRead };

            const pixels = image.pixels; // Uint8ClampedArray (always RGBA)
            const totalBytes = pixels.byteLength;
            const rowBytes = image.width * 4;

            const meta = {
                width: image.width,
                height: image.height,
                channels: image.channels,
                colorspace: image.colorspace,
                fileSize: fileData.byteLength,
                uri: uri.toString(),
                name: uri.path.split('/').pop() ?? '',
                timing,
            };

            if (totalBytes <= CHUNK_THRESHOLD) {
                // Small image: single Transferable ArrayBuffer
                const ab = pixels.buffer.slice(
                    pixels.byteOffset,
                    pixels.byteOffset + pixels.byteLength
                );
                (panel.webview as any).postMessage(
                    { type: 'image', ...meta, data: ab },
                    [ab]
                );
            } else {
                // Large image: chunked Transferable ArrayBuffer
                (panel.webview as any).postMessage({
                    type: 'imageInit',
                    ...meta,
                });

                const maxRowsPerChunk = Math.max(1, Math.floor(CHUNK_BYTE_LIMIT / rowBytes));
                for (let offsetY = 0; offsetY < image.height; offsetY += maxRowsPerChunk) {
                    const rows = Math.min(maxRowsPerChunk, image.height - offsetY);
                    const start = offsetY * rowBytes;
                    const end = start + rows * rowBytes;
                    const slice = pixels.subarray(start, end);
                    const ab = slice.buffer.slice(
                        slice.byteOffset,
                        slice.byteOffset + slice.byteLength
                    );
                    (panel.webview as any).postMessage(
                        { type: 'imageChunk', offsetY, rows, data: ab },
                        [ab]
                    );
                    if (CHUNK_DELAY_MS > 0) { await new Promise(r => setTimeout(r, CHUNK_DELAY_MS)); }
                }

                panel.webview.postMessage({ type: 'imageDone' });
            }

            console.log(
                `${LOG_PREFIX} ${isSwitch ? 'switchFile' : 'openImage'} ` +
                `${image.width}x${image.height}: ` +
                `read=${timing.read}ms decode=${timing.decode}ms`
            );
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            panel.webview.postMessage({ type: 'error', message: msg });
        }
    }

    // ── PNG Export ─────────────────────────────────────────────────────

    public resetZoom(): void {
        if (this.activeWebviewPanel) {
            this.activeWebviewPanel.webview.postMessage({ type: 'setScale', scale: 'fit' });
        }
    }

    public exportPng(): void {
        if (this.activeWebviewPanel) {
            this.activeWebviewPanel.webview.postMessage({ type: 'requestExport' });
        } else {
            vscode.window.showWarningMessage('No QOI image is open.');
        }
    }

    public async exportPngFile(fileUri: vscode.Uri): Promise<void> {
        try {
            const fileData = await vscode.workspace.fs.readFile(fileUri);
            const image = decodeQoi(new Uint8Array(fileData));
            const pngData = encodePng(image.width, image.height, image.pixels);

            const sourcePath = fileUri.fsPath;
            const dir = sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1) || sourcePath.substring(0, sourcePath.lastIndexOf('\\') + 1);
            const baseName = sourcePath.split(/[/\\]/).pop()?.replace(/\.qoi$/i, '') ?? 'image';
            const defaultUri = vscode.Uri.file(dir + baseName + '.png');

            const saveUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'PNG Image': ['png'] },
                title: vscode.l10n.t('Export QOI as PNG'),
            });

            if (!saveUri) { return; }

            await vscode.workspace.fs.writeFile(saveUri, pngData);
            vscode.window.showInformationMessage(`PNG exported: ${saveUri.fsPath}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to export PNG: ${msg}`);
        }
    }

    private async handleExportPng(dataUrl: string, sourceUri: vscode.Uri): Promise<void> {
        const sourcePath = sourceUri.fsPath;
        const dir = sourcePath.substring(0, sourcePath.lastIndexOf('/') + 1) || sourcePath.substring(0, sourcePath.lastIndexOf('\\') + 1);
        const baseName = sourcePath.split(/[/\\]/).pop()?.replace(/\.qoi$/i, '') ?? 'image';
        const defaultUri = vscode.Uri.file(dir + baseName + '.png');

        const saveUri = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'PNG Image': ['png'] },
            title: vscode.l10n.t('Export QOI as PNG'),
        });

        if (!saveUri) { return; }

        try {
            const base64 = dataUrl.split(',')[1];
            const binary = Buffer.from(base64, 'base64');
            await vscode.workspace.fs.writeFile(saveUri, binary);
            vscode.window.showInformationMessage(`PNG exported: ${saveUri.fsPath}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Failed to export PNG: ${msg}`);
        }
    }

    // ── HTML ───────────────────────────────────────────────────────────

    private getHtml(cssUri: vscode.Uri, jsUri: vscode.Uri): string {
        const htmlPath = path.join(this.context.extensionPath, 'media', 'editor.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        html = html.replace('{{cssUri}}', cssUri.toString());
        html = html.replace('{{jsUri}}', jsUri.toString());
        return html;
    }
}
