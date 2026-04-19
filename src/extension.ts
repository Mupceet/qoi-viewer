/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { QoiEditorProvider } from './preview';
import { InfoStatusBarEntry } from './infoStatusBarEntry';
import { ZoomStatusBarEntry } from './zoomStatusBarEntry';

export function activate(context: vscode.ExtensionContext) {
    const infoStatusBarEntry = new InfoStatusBarEntry();
    context.subscriptions.push(infoStatusBarEntry);

    const zoomStatusBarEntry = new ZoomStatusBarEntry();
    context.subscriptions.push(zoomStatusBarEntry);

    const provider = new QoiEditorProvider(context, infoStatusBarEntry, zoomStatusBarEntry);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            QoiEditorProvider.viewType,
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        ),
        vscode.commands.registerCommand('qoiViewer.exportPng', () => {
            provider.exportPng();
        }),
        vscode.commands.registerCommand('qoiViewer.exportPngFile', (uri: vscode.Uri) => {
            provider.exportPngFile(uri);
        }),
        vscode.commands.registerCommand('qoiViewer.resetZoom', () => {
            provider.resetZoom();
        })
    );
}

export function deactivate() {}
