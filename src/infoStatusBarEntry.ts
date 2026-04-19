/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { PreviewStatusBarEntry } from './ownedStatusBarEntry';

export class InfoStatusBarEntry extends PreviewStatusBarEntry {

	constructor() {
		super('status.qoi.info', 'Image Info', vscode.StatusBarAlignment.Right, 101);
	}

	public show(owner: string, text: string) {
		this.showItem(owner, text);
	}
}
