/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Disposable } from './dispose';
import { SizeStatusBarEntry } from './sizeStatusBarEntry';
import { Scale, ZoomStatusBarEntry } from './zoomStatusBarEntry';
import { BinarySizeStatusBarEntry } from './binarySizeStatusBarEntry';
import { PNG } from 'pngjs';
import * as fs from 'fs';
import { Stream } from 'stream';
import * as QOI from './decode';

const localize = nls.loadMessageBundle();

export class PreviewManager implements vscode.CustomReadonlyEditorProvider {

	public static readonly viewType = 'qoi.previewEditor';

	private readonly _previews = new Set<Preview>();
	private _activePreview: Preview | undefined;

	constructor(
		private readonly extensionRoot: vscode.Uri,
		private readonly sizeStatusBarEntry: SizeStatusBarEntry,
		private readonly binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
		private readonly zoomStatusBarEntry: ZoomStatusBarEntry,
	) { }

	public async openCustomDocument(uri: vscode.Uri) {
		return { uri, dispose: () => { } };
	}


	public async resolveCustomEditor(
		document: vscode.CustomDocument,
		webviewEditor: vscode.WebviewPanel,
	): Promise<void> {
		const preview = new Preview(this.extensionRoot, document.uri, webviewEditor, this.sizeStatusBarEntry, this.binarySizeStatusBarEntry, this.zoomStatusBarEntry);
		this._previews.add(preview);
		this.setActivePreview(preview);

		webviewEditor.onDidDispose(() => { this._previews.delete(preview); });

		webviewEditor.onDidChangeViewState(() => {
			if (webviewEditor.active) {
				this.setActivePreview(preview);
			} else if (this._activePreview === preview && !webviewEditor.active) {
				this.setActivePreview(undefined);
			}
		});
	}

	public get activePreview() { return this._activePreview; }

	private setActivePreview(value: Preview | undefined): void {
		this._activePreview = value;
		this.setPreviewActiveContext(!!value);
	}

	private setPreviewActiveContext(value: boolean) {
		vscode.commands.executeCommand('setContext', 'qoiFocus', value);
	}
}

const enum PreviewState {
	Disposed,
	Visible,
	Active,
}

class Preview extends Disposable {

	private readonly id: string = `${Date.now()}-${Math.random().toString()}`;

	private _previewState = PreviewState.Visible;
	private _imageSize: string | undefined;
	private _imageBinarySize: number | undefined;
	private _imageZoom: Scale | undefined;

	private readonly emptyPngDataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR42gEFAPr/AP///wAI/AL+Sr4t6gAAAABJRU5ErkJggg==';

	constructor(
		private readonly extensionRoot: vscode.Uri,
		private readonly resource: vscode.Uri,
		private readonly webviewEditor: vscode.WebviewPanel,
		private readonly sizeStatusBarEntry: SizeStatusBarEntry,
		private readonly binarySizeStatusBarEntry: BinarySizeStatusBarEntry,
		private readonly zoomStatusBarEntry: ZoomStatusBarEntry,
	) {
		super();
		const resourceRoot = resource.with({
			path: resource.path.replace(/\/[^\/]+?\.\w+$/, '/'),
		});

		webviewEditor.webview.options = {
			enableScripts: true,
			enableForms: false,
			localResourceRoots: [
				resourceRoot,
				extensionRoot,
			]
		};

		this._register(webviewEditor.webview.onDidReceiveMessage(message => {
			switch (message.type) {
				case 'size':
					{
						this._imageSize = message.value;
						this.update();
						break;
					}
				case 'zoom':
					{
						this._imageZoom = message.value;
						this.update();
						break;
					}

				case 'reopen-as-text':
					{
						vscode.commands.executeCommand('vscode.openWith', resource, 'default', webviewEditor.viewColumn);
						break;
					}

				case 'savePng':
					{
						this.savePng();
						break;
					}
			}
		}));

		this._register(zoomStatusBarEntry.onDidChangeScale(e => {
			if (this._previewState === PreviewState.Active) {
				this.webviewEditor.webview.postMessage({ type: 'setScale', scale: e.scale });
			}
		}));

		this._register(webviewEditor.onDidChangeViewState(() => {
			this.update();
			this.webviewEditor.webview.postMessage({ type: 'setActive', value: this.webviewEditor.active });
		}));

		this._register(webviewEditor.onDidDispose(() => {
			if (this._previewState === PreviewState.Active) {
				this.sizeStatusBarEntry.hide(this.id);
				this.binarySizeStatusBarEntry.hide(this.id);
				this.zoomStatusBarEntry.hide(this.id);
			}
			this._previewState = PreviewState.Disposed;
		}));

		const watcher = this._register(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(resource, '*')));
		this._register(watcher.onDidChange(e => {
			if (e.toString() === this.resource.toString()) {
				this.render();
			}
		}));
		this._register(watcher.onDidDelete(e => {
			if (e.toString() === this.resource.toString()) {
				this.webviewEditor.dispose();
			}
		}));

		vscode.workspace.fs.stat(resource).then(({ size }) => {
			this._imageBinarySize = size;
			this.update();
		});

		this.render();
		this.update();
		this.webviewEditor.webview.postMessage({ type: 'setActive', value: this.webviewEditor.active });
	}

	public zoomIn() {
		if (this._previewState === PreviewState.Active) {
			this.webviewEditor.webview.postMessage({ type: 'zoomIn' });
		}
	}

	public zoomOut() {
		if (this._previewState === PreviewState.Active) {
			this.webviewEditor.webview.postMessage({ type: 'zoomOut' });
		}
	}

	private async savePng() {
		try {
			const data = await fs.promises.readFile(this.resource.fsPath);
			let qoi = QOI.decode(data as Buffer, QOI.QOIChannels.RGBA);
			const png = new PNG({ width: qoi.width, height: qoi.height });
			png.data = qoi.pixels as Buffer;
			const buf = await stream2buffer(png.pack());

			const defaultUri = this.resource.with({ path: this.resource.path.replace(/\.[^.]+$/, '.png') });
			const uri = await vscode.window.showSaveDialog({ defaultUri });
			if (!uri) { return; }
			await vscode.workspace.fs.writeFile(uri, buf);
			vscode.window.showInformationMessage(localize('preview.saveSuccess', 'Image saved'));
		} catch (ex) {
			vscode.window.showErrorMessage(localize('preview.saveError', 'Failed to save image'));
		}
	}

	private async render() {
		if (this._previewState !== PreviewState.Disposed) {
			this.webviewEditor.webview.html = await this.getWebviewContents();
		}
	}

	private update() {
		if (this._previewState === PreviewState.Disposed) {
			return;
		}

		if (this.webviewEditor.active) {
			this._previewState = PreviewState.Active;
			this.sizeStatusBarEntry.show(this.id, this._imageSize || '');
			this.binarySizeStatusBarEntry.show(this.id, this._imageBinarySize);
			this.zoomStatusBarEntry.show(this.id, this._imageZoom || 'fit');
		} else {
			if (this._previewState === PreviewState.Active) {
				this.sizeStatusBarEntry.hide(this.id);
				this.binarySizeStatusBarEntry.hide(this.id);
				this.zoomStatusBarEntry.hide(this.id);
			}
			this._previewState = PreviewState.Visible;
		}
	}

	private async getWebviewContents(): Promise<string> {
		const version = Date.now().toString();
		const settings = {
			src: await this.getResourcePath(this.webviewEditor, this.resource, version),
		};

		const nonce = getNonce();

		const cspSource = this.webviewEditor.webview.cspSource;
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">

	<!-- Disable pinch zooming -->
	<meta name="viewport"
		content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">

	<title>Image Preview</title>

	<link rel="stylesheet" href="${escapeAttribute(this.extensionResource('/media/main.css'))}" type="text/css" media="screen" nonce="${nonce}">

	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource}; script-src 'nonce-${nonce}'; style-src ${cspSource} 'nonce-${nonce}';">
	<meta id="image-preview-settings" data-settings="${escapeAttribute(JSON.stringify(settings))}">
</head>
<body class="container image scale-to-fit loading">
	<div class="loading-indicator"></div>
	<div class="image-load-error">
		<p>${localize('preview.imageLoadError', "An error occurred while loading the image.")}</p>
		<a href="#" class="open-file-link">${localize('preview.imageLoadErrorLink', "Open file using VS Code's standard text/binary editor?")}</a>
	</div>
	<script src="${escapeAttribute(this.extensionResource('/media/main.js'))}" nonce="${nonce}"></script>
</body>
</html>`;
	}

	private async getResourcePath(webviewEditor: vscode.WebviewPanel, resource: vscode.Uri, version: string): Promise<string> {
		if (resource.scheme === 'git') {
			const stat = await vscode.workspace.fs.stat(resource);
			if (stat.size === 0) {
				return this.emptyPngDataUri;
			}
		}
		// For large images encoding to PNG and base64 is expensive.
		// Instead, schedule sending raw pixel buffer to the webview as a transferable ArrayBuffer
		// and return a small placeholder image src. The webview will receive `qoiPixels` message
		// and render using canvas.
		this.sendPixels(resource);
		return this.emptyPngDataUri;

	}

	private async sendPixels(resource: vscode.Uri) {
		try {
			const data = await fs.promises.readFile(resource.fsPath);
			let qoi = QOI.decode(data as Buffer, QOI.QOIChannels.RGBA);
			const buf: Buffer = qoi.pixels as Buffer;

			const bytesPerPixel = qoi.channels; // typically 4
			const rowBytes = qoi.width * bytesPerPixel;
			const totalBytes = buf.length;

			// If small enough, send in a single transferable message (backwards compatible)
			const CHUNK_BYTE_LIMIT = 512 * 1024; // 512KB per chunk target
			if (totalBytes <= CHUNK_BYTE_LIMIT) {
				const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
				(this.webviewEditor.webview as any).postMessage({
					type: 'qoiPixels',
					width: qoi.width,
					height: qoi.height,
					channels: qoi.channels,
					data: ab
				}, [ab]);
				return;
			}

			// For large images, send an init message then many chunk messages to reduce peak memory
			(this.webviewEditor.webview as any).postMessage({ type: 'qoiPixelsInit', width: qoi.width, height: qoi.height, channels: qoi.channels });

			const maxRowsPerChunk = Math.max(1, Math.floor(CHUNK_BYTE_LIMIT / rowBytes));
			for (let offsetY = 0; offsetY < qoi.height; offsetY += maxRowsPerChunk) {
				const rows = Math.min(maxRowsPerChunk, qoi.height - offsetY);
				const start = offsetY * rowBytes;
				const end = start + rows * rowBytes;
				const slice = buf.subarray(start, end);
				const ab = slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
				(this.webviewEditor.webview as any).postMessage({
					type: 'qoiPixelsChunk',
					offsetY: offsetY,
					rows: rows,
					data: ab
				}, [ab]);
			}

			(this.webviewEditor.webview as any).postMessage({ type: 'qoiPixelsDone' });
		} catch (ex) {
			this.webviewEditor.webview.postMessage({ type: 'qoiError' });
		}
	}

	private extensionResource(path: string) {
		return this.webviewEditor.webview.asWebviewUri(this.extensionRoot.with({
			path: this.extensionRoot.path + path
		}));
	}
}

function escapeAttribute(value: string | vscode.Uri): string {
	return value.toString().replace(/"/g, '&quot;');
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 64; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

async function stream2buffer(stream: Stream): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const _buf = Array<any>();
		stream.on("data", chunk => _buf.push(chunk));
		stream.on("end", () => resolve(Buffer.concat(_buf)));
		stream.on("error", reject);
	});
} 