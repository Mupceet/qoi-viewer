/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from './ownedStatusBarEntry';

const selectZoomLevelCommandId = '_qoi.selectZoomLevel';

export type Scale = number | 'fit';

export class ZoomStatusBarEntry extends PreviewStatusBarEntry {

	private readonly _onDidChangeScale = this._register(new vscode.EventEmitter<{ scale: Scale }>());
	public readonly onDidChangeScale = this._onDidChangeScale.event;

	constructor() {
		super('status.qoi.zoom', 'Image Zoom', vscode.StatusBarAlignment.Right, 102);

		this._register(vscode.commands.registerCommand(selectZoomLevelCommandId, async () => {
			type MyPickItem = vscode.QuickPickItem & { scale: Scale };

			const scales: Scale[] = [10, 5, 2, 1, 0.5, 0.2, 'fit'];
			const options = scales.map((scale): MyPickItem => ({
				label: this.zoomLabel(scale),
				scale
			}));

			const pick = await vscode.window.showQuickPick(options, {
				placeHolder: 'Select zoom level'
			});
			if (pick) {
				this._onDidChangeScale.fire({ scale: pick.scale });
			}
		}));

		this.entry.command = selectZoomLevelCommandId;
	}

	public show(owner: string, scale: Scale) {
		this.showItem(owner, this.zoomLabel(scale));
	}

	private zoomLabel(scale: Scale): string {
		return scale === 'fit' ? 'Whole Image' : `${Math.round(scale * 100)}%`;
	}
}
