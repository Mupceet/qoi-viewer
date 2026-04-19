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
import { decode as decodeQoi } from './decodeQoi';
import { encode as encodePng } from './encodePng';
import { InfoStatusBarEntry } from './infoStatusBarEntry';
import { Scale, ZoomStatusBarEntry } from './zoomStatusBarEntry';

const LOG_PREFIX = '[QOI Viewer]';
const CHUNK_THRESHOLD = 8 * 1024 * 1024; // 8MB: use chunked transfer above this size
const CHUNK_BYTE_LIMIT = 4 * 1024 * 1024; // 2MB per chunk
const CHUNK_DELAY_MS = 0; // Set > 0 (e.g. 200) to debug progressive rendering

export class QoiEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'qoi.previewEditor';

    private activeWebviewPanel: vscode.WebviewPanel | undefined;
    private activeUri: vscode.Uri | undefined;
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
                    const saveLabel = 'Save as PNG';
                    const pick = await vscode.window.showQuickPick([saveLabel], { placeHolder: '' });
                    if (pick === saveLabel) {
                        this.exportPng();
                    }
                    break;
                }
                case 'exportPng':
                    await this.handleExportPng(message.dataUrl, currentUri);
                    break;
                case 'ready':
                    this.sendImagePixels(webviewPanel, document.uri);
                    break;
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

    /**
     * Decode QOI file and send pixels to webview.
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

            const pixels = image.pixels; // Uint8ClampedArray (always RGBA)
            const totalBytes = pixels.byteLength;
            const rowBytes = image.width * 4;
            const timing = { read: tRead - t0, decode: tDecode - tRead };

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
                title: 'Export QOI as PNG',
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
            title: 'Export QOI as PNG',
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
