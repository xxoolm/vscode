/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { Codicon } from 'vs/base/common/codicons';
import { Color } from 'vs/base/common/color';
import { KeyCode } from 'vs/base/common/keyCodes';
import { Disposable, IReference, MutableDisposable } from 'vs/base/common/lifecycle';
import { clamp } from 'vs/base/common/numbers';
import { count } from 'vs/base/common/strings';
import { URI } from 'vs/base/common/uri';
import { ICodeEditor, isCodeEditor } from 'vs/editor/browser/editorBrowser';
import { EditorAction2 } from 'vs/editor/browser/editorExtensions';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { EmbeddedCodeEditorWidget, EmbeddedDiffEditorWidget } from 'vs/editor/browser/widget/embeddedCodeEditorWidget';
import { IDiffEditorOptions, IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { IResolvedTextEditorModel, ITextModelService } from 'vs/editor/common/services/resolverService';
import { getOuterEditor, IPeekViewService, peekViewTitleBackground, peekViewTitleForeground, peekViewTitleInfoForeground, PeekViewWidget } from 'vs/editor/contrib/peekView/peekView';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ContextKeyExpr, IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ITextEditorOptions } from 'vs/platform/editor/common/editor';
import { createDecorator, IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IColorTheme, IThemeService } from 'vs/platform/theme/common/themeService';
import { EditorModel } from 'vs/workbench/common/editor';
import { testingPeekBorder } from 'vs/workbench/contrib/testing/browser/theme';
import { AutoOpenPeekViewWhen, getTestingConfiguration, TestingConfigKeys } from 'vs/workbench/contrib/testing/common/configuration';
import { Testing } from 'vs/workbench/contrib/testing/common/constants';
import { ITestItem, ITestMessage, ITestState } from 'vs/workbench/contrib/testing/common/testCollection';
import { TestingContextKeys } from 'vs/workbench/contrib/testing/common/testingContextKeys';
import { isFailedState } from 'vs/workbench/contrib/testing/common/testingStates';
import { buildTestUri, parseTestUri, TestUriType } from 'vs/workbench/contrib/testing/common/testingUri';
import { ITestResult, ITestResultService, TestResultItem, TestResultItemChange, TestResultItemChangeReason } from 'vs/workbench/contrib/testing/common/testResultService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';

interface ITestDto {
	test: ITestItem,
	messageIndex: number;
	state: ITestState;
	expectedUri: URI;
	actualUri: URI;
	messageUri: URI;
}

export interface ITestingPeekOpener {
	_serviceBrand: undefined;

	/**
	 * Tries to peek the first test error, if the item is in a failed state.
	 * @returns a boolean indicating whether a peek was opened
	 */
	tryPeekFirstError(result: ITestResult, test: TestResultItem, options?: Partial<ITextEditorOptions>): Promise<boolean>;
}

export const ITestingPeekOpener = createDecorator<ITestingPeekOpener>('testingPeekOpener');

export class TestingPeekOpener extends Disposable implements ITestingPeekOpener {
	declare _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@ITestResultService testResults: ITestResultService,
	) {
		super();
		this._register(testResults.onTestChanged(this.openPeekOnFailure, this));
	}

	/**
	 * Tries to peek the first test error, if the item is in a failed state.
	 * @returns a boolean if a peek was opened
	 */
	public async tryPeekFirstError(result: ITestResult, test: TestResultItem, options?: Partial<ITextEditorOptions>) {
		const index = test.state.messages.findIndex(m => !!m.location);
		if (index === -1) {
			return false;
		}

		const message = test.state.messages[index];
		const pane = await this.editorService.openEditor({
			resource: message.location!.uri,
			options: { selection: message.location!.range, revealIfOpened: true, ...options }
		});

		const control = pane?.getControl();
		if (!isCodeEditor(control)) {
			return false;
		}

		TestingOutputPeekController.get(control).show(buildTestUri({
			type: TestUriType.ResultMessage,
			messageIndex: index,
			resultId: result.id,
			testExtId: test.item.extId,
		}));

		return true;
	}

	/**
	 * Opens the peek view on a test failure, based on user preferences.
	 */
	private openPeekOnFailure(evt: TestResultItemChange) {
		if (!isFailedState(evt.item.state.state) || !evt.item.state.messages.length) {
			return;
		}

		if (evt.result.isAutoRun && !getTestingConfiguration(this.configuration, TestingConfigKeys.AutoOpenPeekViewDuringAutoRun)) {
			return;
		}

		const editors = this.codeEditorService.listCodeEditors();
		const cfg = getTestingConfiguration(this.configuration, TestingConfigKeys.AutoOpenPeekView);

		// don't show the peek if the user asked to only auto-open peeks for visible tests,
		// and this test is not in any of the editors' models.
		const testUri = evt.item.item.location?.uri.toString();
		if (cfg === AutoOpenPeekViewWhen.FailureVisible && (!testUri || !editors.some(e => e.getModel()?.uri.toString() === testUri))) {
			return;
		}

		const controllers = editors.map(TestingOutputPeekController.get);
		if (controllers.some(c => c?.isVisible)) {
			return;
		}

		this.tryPeekFirstError(evt.result, evt.item);
	}
}

/**
 * Adds output/message peek functionality to code editors.
 */
export class TestingOutputPeekController extends Disposable implements IEditorContribution {
	/**
	 * Gets the controller associated with the given code editor.
	 */
	public static get(editor: ICodeEditor): TestingOutputPeekController {
		return editor.getContribution<TestingOutputPeekController>(Testing.OutputPeekContributionId);
	}

	/**
	 * Currently-shown peek view.
	 */
	private readonly peek = this._register(new MutableDisposable<TestingOutputPeek>());

	/**
	 * Context key updated when the peek is visible/hidden.
	 */
	private readonly visible: IContextKey<boolean>;

	/**
	 * Gets whether a peek is currently shown in the associated editor.
	 */
	public get isVisible() {
		return this.peek.value;
	}

	constructor(
		private readonly editor: ICodeEditor,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITestResultService private readonly testResults: ITestResultService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this.visible = TestingContextKeys.isPeekVisible.bindTo(contextKeyService);
		this._register(editor.onDidChangeModel(() => this.peek.clear()));
		this._register(testResults.onTestChanged((evt) => this.closePeekOnTestChange(evt)));
	}

	/**
	 * Shows a peek for the message in th editor.
	 */
	public async show(uri: URI) {
		const dto = await this.retrieveTest(uri);
		if (!dto) {
			return;
		}

		const message = dto.state.messages[dto.messageIndex];
		if (!message?.location) {
			return;
		}

		const ctor = message.actualOutput !== undefined && message.expectedOutput !== undefined
			? TestingDiffOutputPeek : TestingMessageOutputPeek;
		const isNew = !(this.peek.value instanceof ctor);
		if (isNew) {
			this.peek.value = this.instantiationService.createInstance(ctor, this.editor);
			this.peek.value.onDidClose(() => {
				this.visible.set(false);
				this.peek.value = undefined;
			});
		}

		if (isNew) {
			this.visible.set(true);
			this.peek.value!.create();
		}

		this.peek.value!.setModel(dto);
	}

	/**
	 * Disposes the peek view, if any.
	 */
	public removePeek() {
		this.peek.clear();
	}

	/**
	 * If the test we're currently showing has its state change to something
	 * else, then clear the peek.
	 */
	private closePeekOnTestChange(evt: TestResultItemChange) {
		if (evt.reason !== TestResultItemChangeReason.OwnStateChange || evt.previous.state === evt.item.state.state) {
			return;
		}

		const displayed = this.peek.value?.currentTest();
		if (displayed?.extId === evt.item.item.extId) {
			this.peek.clear();
		}
	}

	private retrieveTest(uri: URI): ITestDto | undefined {
		const parts = parseTestUri(uri);
		if (!parts) {
			return undefined;
		}

		const test = this.testResults.getResult(parts.resultId)?.getStateByExtId(parts.testExtId);
		return test && {
			test: test.item,
			state: test.state,
			messageIndex: parts.messageIndex,
			expectedUri: buildTestUri({ ...parts, type: TestUriType.ResultExpectedOutput }),
			actualUri: buildTestUri({ ...parts, type: TestUriType.ResultActualOutput }),
			messageUri: buildTestUri({ ...parts, type: TestUriType.ResultMessage }),
		};
	}
}

abstract class TestingOutputPeek extends PeekViewWidget {
	protected model = new MutableDisposable();
	protected dimension?: dom.Dimension;

	constructor(
		editor: ICodeEditor,
		@IThemeService themeService: IThemeService,
		@IPeekViewService peekViewService: IPeekViewService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@ITextModelService protected readonly modelService: ITextModelService,
	) {
		super(editor, { showFrame: false, showArrow: true, isResizeable: true, isAccessible: true, className: 'test-output-peek' }, instantiationService);

		TestingContextKeys.isInPeek.bindTo(contextKeyService);
		this._disposables.add(themeService.onDidColorThemeChange(this.applyTheme, this));
		this._disposables.add(this.model);
		this.applyTheme(themeService.getColorTheme());
		peekViewService.addExclusiveWidget(editor, this);
	}

	private applyTheme(theme: IColorTheme) {
		const borderColor = theme.getColor(testingPeekBorder) || Color.transparent;
		this.style({
			arrowColor: borderColor,
			frameColor: borderColor,
			headerBackgroundColor: theme.getColor(peekViewTitleBackground) || Color.transparent,
			primaryHeadingColor: theme.getColor(peekViewTitleForeground),
			secondaryHeadingColor: theme.getColor(peekViewTitleInfoForeground)
		});
	}

	/**
	 * Updates the test to be shown.
	 */
	public abstract setModel(dto: ITestDto): Promise<void>;

	/**
	 * Returns the test whose data is currently shown in the peek view.
	 */
	public abstract currentTest(): ITestItem | undefined;

	/**
	 * @override
	 */
	protected _doLayoutBody(height: number, width: number) {
		super._doLayoutBody(height, width);
		this.dimension = new dom.Dimension(width, height);
	}
}

const commonEditorOptions: IEditorOptions = {
	scrollBeyondLastLine: false,
	scrollbar: {
		verticalScrollbarSize: 14,
		horizontal: 'auto',
		useShadows: true,
		verticalHasArrows: false,
		horizontalHasArrows: false,
		alwaysConsumeMouseWheel: false
	},
	fixedOverflowWidgets: true,
	readOnly: true,
	minimap: {
		enabled: false
	},
};

const diffEditorOptions: IDiffEditorOptions = {
	...commonEditorOptions,
	enableSplitViewResizing: true,
	isInEmbeddedEditor: true,
	renderOverviewRuler: false,
	ignoreTrimWhitespace: false,
	renderSideBySide: true,
};

class TestingDiffOutputPeek extends TestingOutputPeek {
	private readonly diff = this._disposables.add(new MutableDisposable<EmbeddedDiffEditorWidget>());
	private test: ITestItem | undefined;

	/**
	 * @override
	 */
	protected _fillBody(containerElement: HTMLElement): void {
		const diffContainer = dom.append(containerElement, dom.$('div.preview.inline'));
		const preview = this.diff.value = this.instantiationService.createInstance(EmbeddedDiffEditorWidget, diffContainer, diffEditorOptions, this.editor);

		if (this.dimension) {
			preview.layout(this.dimension);
		}
	}

	/**
	 * @override
	 */
	public async setModel({ test, state, messageIndex, expectedUri, actualUri }: ITestDto) {
		const message = state.messages[messageIndex];
		if (!message?.location) {
			return;
		}

		this.test = test;
		this.show(message.location.range, hintDiffPeekHeight(message));
		this.setTitle(message.message.toString(), test.label);

		const [original, modified] = await Promise.all([
			this.modelService.createModelReference(expectedUri),
			this.modelService.createModelReference(actualUri),
		]);

		const model = this.model.value = new SimpleDiffEditorModel(original, modified);
		if (!this.diff.value) {
			this.model.value = undefined;
		} else {
			this.diff.value.setModel(model);
		}
	}

	/**
	 * @override
	 */
	public currentTest() {
		return this.test;
	}

	/**
	 * @override
	 */
	protected _doLayoutBody(height: number, width: number) {
		super._doLayoutBody(height, width);
		this.diff.value?.layout(this.dimension);
	}
}

class TestingMessageOutputPeek extends TestingOutputPeek {
	private readonly preview = this._disposables.add(new MutableDisposable<EmbeddedCodeEditorWidget>());
	private test: ITestItem | undefined;

	/**
	 * @override
	 */
	protected _fillBody(containerElement: HTMLElement): void {
		const diffContainer = dom.append(containerElement, dom.$('div.preview.inline'));
		const preview = this.preview.value = this.instantiationService.createInstance(EmbeddedCodeEditorWidget, diffContainer, commonEditorOptions, this.editor);

		if (this.dimension) {
			preview.layout(this.dimension);
		}
	}

	/**
	 * @override
	 */
	public async setModel({ state, test, messageIndex, messageUri }: ITestDto) {
		const message = state.messages[messageIndex];
		if (!message?.location) {
			return;
		}

		this.test = test;
		this.show(message.location.range, hintPeekStrHeight(message.message.toString()));
		this.setTitle(message.message.toString(), test.label);

		const modelRef = this.model.value = await this.modelService.createModelReference(messageUri);
		if (this.preview.value) {
			this.preview.value.setModel(modelRef.object.textEditorModel);
		} else {
			this.model.value = undefined;
		}
	}

	/**
	 * @override
	 */
	public currentTest() {
		return this.test;
	}

	/**
	 * @override
	 */
	protected _doLayoutBody(height: number, width: number) {
		super._doLayoutBody(height, width);
		this.preview.value?.layout(this.dimension);
	}
}

const hintDiffPeekHeight = (message: ITestMessage) =>
	Math.max(hintPeekStrHeight(message.actualOutput), hintPeekStrHeight(message.expectedOutput));

const hintPeekStrHeight = (str: string | undefined) => clamp(count(str || '', '\n'), 5, 20);

class SimpleDiffEditorModel extends EditorModel {
	public readonly original = this._original.object.textEditorModel;
	public readonly modified = this._modified.object.textEditorModel;

	constructor(
		private readonly _original: IReference<IResolvedTextEditorModel>,
		private readonly _modified: IReference<IResolvedTextEditorModel>,
	) {
		super();
	}

	async load(): Promise<this> {
		return this;
	}

	public dispose() {
		super.dispose();
		this._original.dispose();
		this._modified.dispose();
	}
}

function getOuterEditorFromDiffEditor(accessor: ServicesAccessor): ICodeEditor | null {
	const diffEditors = accessor.get(ICodeEditorService).listDiffEditors();

	for (const diffEditor of diffEditors) {
		if (diffEditor.hasTextFocus() && diffEditor instanceof EmbeddedDiffEditorWidget) {
			return diffEditor.getParentEditor();
		}
	}

	return getOuterEditor(accessor);
}

export class CloseTestPeek extends EditorAction2 {
	constructor() {
		super({
			id: 'editor.closeTestPeek',
			title: localize('close', 'Close'),
			icon: Codicon.close,
			precondition: ContextKeyExpr.and(
				ContextKeyExpr.or(TestingContextKeys.isInPeek, TestingContextKeys.isPeekVisible),
				ContextKeyExpr.not('config.editor.stablePeek')
			),
			keybinding: {
				weight: KeybindingWeight.EditorContrib - 101,
				primary: KeyCode.Escape
			}
		});
	}

	runEditorCommand(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const parent = getOuterEditorFromDiffEditor(accessor);
		TestingOutputPeekController.get(parent ?? editor).removePeek();
	}
}
