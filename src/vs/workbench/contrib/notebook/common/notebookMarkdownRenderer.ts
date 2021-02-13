/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { ExtensionIdentifier, IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { INotebookMarkdownRendererInfo } from 'vs/workbench/contrib/notebook/common/notebookCommon';

export class NotebookMarkdownRendererInfo implements INotebookMarkdownRendererInfo {

	readonly id: string;
	readonly entrypoint: URI;
	readonly displayName: string;
	readonly extensionLocation: URI;
	readonly extensionId: ExtensionIdentifier;
	readonly extensionIsBuiltin: boolean;

	constructor(descriptor: {
		readonly id: string;
		readonly displayName: string;
		readonly entrypoint: string;
		readonly extension: IExtensionDescription;
	}) {
		this.id = descriptor.id;
		this.extensionId = descriptor.extension.identifier;
		this.extensionLocation = descriptor.extension.extensionLocation;
		this.entrypoint = joinPath(this.extensionLocation, descriptor.entrypoint);
		this.displayName = descriptor.displayName;
		this.extensionIsBuiltin = descriptor.extension.isBuiltin;
	}
}
