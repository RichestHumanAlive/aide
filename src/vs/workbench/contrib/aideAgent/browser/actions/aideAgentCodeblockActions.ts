/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { CopyAction } from '../../../../../editor/contrib/clipboard/browser/clipboard.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { accessibleViewInCodeBlock } from '../../../accessibility/browser/accessibilityConfiguration.js';
import { CONTEXT_CHAT_EDIT_APPLIED, CONTEXT_CHAT_ENABLED, CONTEXT_IN_CHAT_INPUT, CONTEXT_IN_CHAT_SESSION } from '../../common/aideAgentContextKeys.js';
import { ChatCopyKind, IAideAgentService } from '../../common/aideAgentService.js';
import { IChatResponseViewModel, isResponseVM } from '../../common/aideAgentViewModel.js';
import { IAideAgentCodeBlockContextProviderService, IAideAgentWidgetService } from '../aideAgent.js';
import { DefaultChatTextEditor, ICodeBlockActionContext, ICodeCompareBlockActionContext } from '../codeBlockPart.js';
import { CHAT_CATEGORY } from './aideAgentChatActions.js';
import { InsertCodeBlockOperation } from './codeBlockOperations.js';

/*
const shellLangIds = [
	'fish',
	'ps1',
	'pwsh',
	'powershell',
	'sh',
	'shellscript',
	'zsh'
];
*/

export interface IChatCodeBlockActionContext extends ICodeBlockActionContext {
	element: IChatResponseViewModel;
}

export function isCodeBlockActionContext(thing: unknown): thing is ICodeBlockActionContext {
	return typeof thing === 'object' && thing !== null && 'code' in thing && 'element' in thing;
}

export function isCodeCompareBlockActionContext(thing: unknown): thing is ICodeCompareBlockActionContext {
	return typeof thing === 'object' && thing !== null && 'element' in thing;
}

function isResponseFiltered(context: ICodeBlockActionContext) {
	return isResponseVM(context.element) && context.element.errorDetails?.responseIsFiltered;
}

abstract class ChatCodeBlockAction extends Action2 {
	run(accessor: ServicesAccessor, ...args: any[]) {
		let context = args[0];
		if (!isCodeBlockActionContext(context)) {
			const codeEditorService = accessor.get(ICodeEditorService);
			const editor = codeEditorService.getFocusedCodeEditor() || codeEditorService.getActiveCodeEditor();
			if (!editor) {
				return;
			}

			context = getContextFromEditor(editor, accessor);
			if (!isCodeBlockActionContext(context)) {
				return;
			}
		}

		return this.runWithContext(accessor, context);
	}

	abstract runWithContext(accessor: ServicesAccessor, context: ICodeBlockActionContext): any;
}

export function registerChatCodeBlockActions() {
	registerAction2(class CopyCodeBlockAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.aideAgent.copyCodeBlock',
				title: localize2('interactive.copyCodeBlock.label', "Copy"),
				f1: false,
				category: CHAT_CATEGORY,
				icon: Codicon.copy,
				menu: {
					id: MenuId.AideAgentCodeBlock,
					group: 'navigation',
					order: 30
				}
			});
		}

		run(accessor: ServicesAccessor, ...args: any[]) {
			const context = args[0];
			if (!isCodeBlockActionContext(context) || isResponseFiltered(context)) {
				return;
			}

			const clipboardService = accessor.get(IClipboardService);
			clipboardService.writeText(context.code);

			if (isResponseVM(context.element)) {
				const chatService = accessor.get(IAideAgentService);
				chatService.notifyUserAction({
					agentId: context.element.agent?.id,
					command: context.element.slashCommand?.name,
					sessionId: context.element.sessionId,
					// requestId: context.element.requestId,
					// TODO(@ghostwriternr): This is obviously wrong, but not critical to fix yet.
					requestId: context.element.id,
					result: context.element.result,
					action: {
						kind: 'copy',
						codeBlockIndex: context.codeBlockIndex,
						copyKind: ChatCopyKind.Toolbar,
						copiedCharacters: context.code.length,
						totalCharacters: context.code.length,
						copiedText: context.code,
					}
				});
			}
		}
	});

	CopyAction?.addImplementation(50000, 'chat-codeblock', (accessor) => {
		// get active code editor
		const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
		if (!editor) {
			return false;
		}

		const editorModel = editor.getModel();
		if (!editorModel) {
			return false;
		}

		const context = getContextFromEditor(editor, accessor);
		if (!context) {
			return false;
		}

		const noSelection = editor.getSelections()?.length === 1 && editor.getSelection()?.isEmpty();
		const copiedText = noSelection ?
			editorModel.getValue() :
			editor.getSelections()?.reduce((acc, selection) => acc + editorModel.getValueInRange(selection), '') ?? '';
		const totalCharacters = editorModel.getValueLength();

		// Report copy to extensions
		const chatService = accessor.get(IAideAgentService);
		const element = context.element as IChatResponseViewModel | undefined;
		if (element) {
			chatService.notifyUserAction({
				agentId: element.agent?.id,
				command: element.slashCommand?.name,
				sessionId: element.sessionId,
				// requestId: element.requestId,
				// TODO(@ghostwriternr): This is obviously wrong, but not critical to fix yet.
				requestId: element.id,
				result: element.result,
				action: {
					kind: 'copy',
					codeBlockIndex: context.codeBlockIndex,
					copyKind: ChatCopyKind.Action,
					copiedText,
					copiedCharacters: copiedText.length,
					totalCharacters,
				}
			});
		}

		// Copy full cell if no selection, otherwise fall back on normal editor implementation
		if (noSelection) {
			accessor.get(IClipboardService).writeText(context.code);
			return true;
		}

		return false;
	});

	/*
	registerAction2(class SmartApplyInEditorAction extends ChatCodeBlockAction {

		private operation: ApplyCodeBlockOperation | undefined;

		constructor() {
			super({
				id: 'workbench.action.aideAgent.applyInEditor',
				title: localize2('interactive.applyInEditor.label', "Apply in Editor"),
				precondition: CONTEXT_CHAT_ENABLED,
				f1: true,
				category: CHAT_CATEGORY,
				icon: Codicon.gitPullRequestGoToChanges,

				menu: {
					id: MenuId.AideAgentCodeBlock,
					group: 'navigation',
					when: ContextKeyExpr.and(
						CONTEXT_IN_CHAT_SESSION,
						...shellLangIds.map(e => ContextKeyExpr.notEquals(EditorContextKeys.languageId.key, e))
					),
					order: 10
				},
				keybinding: {
					when: ContextKeyExpr.or(ContextKeyExpr.and(CONTEXT_IN_CHAT_SESSION, CONTEXT_IN_CHAT_INPUT.negate()), accessibleViewInCodeBlock),
					primary: KeyMod.CtrlCmd | KeyCode.Enter,
					mac: { primary: KeyMod.WinCtrl | KeyCode.Enter },
					weight: KeybindingWeight.ExternalExtension + 1
				},
			});
		}

		override runWithContext(accessor: ServicesAccessor, context: ICodeBlockActionContext) {
			if (!this.operation) {
				this.operation = accessor.get(IInstantiationService).createInstance(ApplyCodeBlockOperation);
			}
			return this.operation.run(context);
		}
	});

	registerAction2(class ApplyAllAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.aideAgent.applyAll',
				title: localize2('chat.applyAll.label', "Apply All Edits"),
				precondition: CONTEXT_CHAT_ENABLED, // improve this condition
				f1: true,
				category: CHAT_CATEGORY,
				icon: Codicon.edit
			});
		}

		override async run(accessor: ServicesAccessor, ...args: any[]) {
			const chatWidgetService = accessor.get(IAideAgentWidgetService);
			const codemapperService = accessor.get(IAideAgentCodeMapperService);
			const progressService = accessor.get(IProgressService);
			const chatEditingService = accessor.get(IAideAgentEditingService);
			const notificationService = accessor.get(INotificationService);

			if (chatEditingService.currentEditingSession) {
				// there is already an editing session active, we should not start a new one
				// TODO: figure out a way to implement follow-ups
				notificationService.info(localize('chatCodeBlock.applyAll.editingSessionActive', 'An editing session is already active, please accept or reject the current proposed edits before continuing.'));
				return;
			}

			const widget = chatWidgetService.lastFocusedWidget;
			if (!widget) {
				return;
			}

			const item = widget.getFocus();
			if (!isResponseVM(item)) {
				return;
			}

			const codeblocks = widget.getCodeBlockInfosForResponse(item);
			const request: ICodeMapperCodeBlock[] = [];
			for (const codeblock of codeblocks) {
				if (codeblock.codemapperUri && codeblock.uri) {
					const code = codeblock.getContent();
					request.push({ resource: codeblock.codemapperUri, code });
				}
			}

			await chatEditingService.createEditingSession(async (stream) => {

				const response = {
					textEdit: (resource: URI, textEdits: TextEdit[]) => {
						stream.textEdits(resource, textEdits);
					}
				};

				// Invoke the code mapper for all the code blocks in this response
				const tokenSource = new CancellationTokenSource();
				await progressService.withProgress({
					location: ProgressLocation.Notification,
					title: localize2('chatCodeBlock.generatingEdits', 'Applying all edits').value,
					cancellable: true
				}, async (task) => {
					task.report({ message: localize2('chatCodeBlock.generating', 'Generating edits...').value });
					await codemapperService.mapCode({ codeBlocks: request, conversation: [] }, response, tokenSource.token);
					task.report({ message: localize2('chatCodeBlock.applyAllEdits', 'Applying edits to workspace...').value });
				}, () => tokenSource.cancel());
			});
		}
	});
	*/

	registerAction2(class SmartApplyInEditorAction extends ChatCodeBlockAction {
		constructor() {
			super({
				id: 'workbench.action.aideAgent.insertCodeBlock',
				title: localize2('interactive.insertCodeBlock.label', "Insert At Cursor"),
				precondition: CONTEXT_CHAT_ENABLED,
				f1: true,
				category: CHAT_CATEGORY,
				icon: Codicon.insert,
				menu: {
					id: MenuId.AideAgentCodeBlock,
					group: 'navigation',
					when: CONTEXT_IN_CHAT_SESSION,
					order: 20
				},
				keybinding: {
					when: ContextKeyExpr.or(ContextKeyExpr.and(CONTEXT_IN_CHAT_SESSION, CONTEXT_IN_CHAT_INPUT.negate()), accessibleViewInCodeBlock),
					primary: KeyMod.CtrlCmd | KeyCode.Enter,
					mac: { primary: KeyMod.WinCtrl | KeyCode.Enter },
					weight: KeybindingWeight.ExternalExtension + 1
				},
			});
		}

		override runWithContext(accessor: ServicesAccessor, context: ICodeBlockActionContext) {
			const operation = accessor.get(IInstantiationService).createInstance(InsertCodeBlockOperation);
			return operation.run(context);
		}
	});

	/*
	registerAction2(class InsertIntoNewFileAction extends ChatCodeBlockAction {
		constructor() {
			super({
				id: 'workbench.action.aideAgent.insertIntoNewFile',
				title: localize2('interactive.insertIntoNewFile.label', "Insert into New File"),
				precondition: CONTEXT_CHAT_ENABLED,
				f1: true,
				category: CHAT_CATEGORY,
				icon: Codicon.newFile,
				menu: {
					id: MenuId.AideAgentCodeBlock,
					group: 'navigation',
					isHiddenByDefault: true,
					order: 40,
				}
			});
		}

		override async runWithContext(accessor: ServicesAccessor, context: ICodeBlockActionContext) {
			if (isResponseFiltered(context)) {
				// When run from command palette
				return;
			}

			const editorService = accessor.get(IEditorService);
			const chatService = accessor.get(IAideAgentService);

			editorService.openEditor({ contents: context.code, languageId: context.languageId, resource: undefined } satisfies IUntitledTextResourceEditorInput);

			if (isResponseVM(context.element)) {
				chatService.notifyUserAction({
					agentId: context.element.agent?.id,
					command: context.element.slashCommand?.name,
					sessionId: context.element.sessionId,
					// requestId: context.element.requestId,
					// TODO(@ghostwriternr): This is obviously wrong, but not critical to fix yet.
					requestId: context.element.id,
					result: context.element.result,
					action: {
						kind: 'insert',
						codeBlockIndex: context.codeBlockIndex,
						totalCharacters: context.code.length,
						newFile: true
					}
				});
			}
		}
	});

	registerAction2(class RunInTerminalAction extends ChatCodeBlockAction {
		constructor() {
			super({
				id: 'workbench.action.aideAgent.runInTerminal',
				title: localize2('interactive.runInTerminal.label', "Insert into Terminal"),
				precondition: CONTEXT_CHAT_ENABLED,
				f1: true,
				category: CHAT_CATEGORY,
				icon: Codicon.terminal,
				menu: [{
					id: MenuId.AideAgentCodeBlock,
					group: 'navigation',
					when: ContextKeyExpr.and(
						CONTEXT_IN_CHAT_SESSION,
						ContextKeyExpr.or(...shellLangIds.map(e => ContextKeyExpr.equals(EditorContextKeys.languageId.key, e)))
					),
				},
				{
					id: MenuId.AideAgentCodeBlock,
					group: 'navigation',
					isHiddenByDefault: true,
					when: ContextKeyExpr.and(
						CONTEXT_IN_CHAT_SESSION,
						...shellLangIds.map(e => ContextKeyExpr.notEquals(EditorContextKeys.languageId.key, e))
					)
				}],
				keybinding: [{
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Enter,
					mac: {
						primary: KeyMod.WinCtrl | KeyMod.Alt | KeyCode.Enter
					},
					weight: KeybindingWeight.EditorContrib,
					when: ContextKeyExpr.or(CONTEXT_IN_CHAT_SESSION, accessibleViewInCodeBlock),
				}]
			});
		}

		override async runWithContext(accessor: ServicesAccessor, context: ICodeBlockActionContext) {
			if (isResponseFiltered(context)) {
				// When run from command palette
				return;
			}

			const chatService = accessor.get(IAideAgentService);
			const terminalService = accessor.get(ITerminalService);
			const editorService = accessor.get(IEditorService);
			const terminalEditorService = accessor.get(ITerminalEditorService);
			const terminalGroupService = accessor.get(ITerminalGroupService);

			let terminal = await terminalService.getActiveOrCreateInstance();

			// isFeatureTerminal = debug terminal or task terminal
			const unusableTerminal = terminal.xterm?.isStdinDisabled || terminal.shellLaunchConfig.isFeatureTerminal;
			terminal = unusableTerminal ? await terminalService.createTerminal() : terminal;

			terminalService.setActiveInstance(terminal);
			await terminal.focusWhenReady(true);
			if (terminal.target === TerminalLocation.Editor) {
				const existingEditors = editorService.findEditors(terminal.resource);
				terminalEditorService.openEditor(terminal, { viewColumn: existingEditors?.[0].groupId });
			} else {
				terminalGroupService.showPanel(true);
			}

			terminal.runCommand(context.code, false);

			if (isResponseVM(context.element)) {
				chatService.notifyUserAction({
					agentId: context.element.agent?.id,
					command: context.element.slashCommand?.name,
					sessionId: context.element.sessionId,
					// requestId: context.element.requestId,
					// TODO(@ghostwriternr): This is obviously wrong, but not critical to fix yet.
					requestId: context.element.id,
					result: context.element.result,
					action: {
						kind: 'runInTerminal',
						codeBlockIndex: context.codeBlockIndex,
						languageId: context.languageId,
					}
				});
			}
		}
	});
	*/

	function navigateCodeBlocks(accessor: ServicesAccessor, reverse?: boolean): void {
		const codeEditorService = accessor.get(ICodeEditorService);
		const chatWidgetService = accessor.get(IAideAgentWidgetService);
		const widget = chatWidgetService.lastFocusedWidget;
		if (!widget) {
			return;
		}

		const editor = codeEditorService.getFocusedCodeEditor();
		const editorUri = editor?.getModel()?.uri;
		const curCodeBlockInfo = editorUri ? widget.getCodeBlockInfoForEditor(editorUri) : undefined;
		const focused = !widget.inputEditor.hasWidgetFocus() && widget.getFocus();
		const focusedResponse = isResponseVM(focused) ? focused : undefined;

		const currentResponse = curCodeBlockInfo ?
			curCodeBlockInfo.element :
			(focusedResponse ?? widget.viewModel?.getItems().reverse().find((item): item is IChatResponseViewModel => isResponseVM(item)));
		if (!currentResponse || !isResponseVM(currentResponse)) {
			return;
		}

		widget.reveal(currentResponse);
		const responseCodeblocks = widget.getCodeBlockInfosForResponse(currentResponse);
		const focusIdx = curCodeBlockInfo ?
			(curCodeBlockInfo.codeBlockIndex + (reverse ? -1 : 1) + responseCodeblocks.length) % responseCodeblocks.length :
			reverse ? responseCodeblocks.length - 1 : 0;

		responseCodeblocks[focusIdx]?.focus();
	}

	registerAction2(class NextCodeBlockAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.aideAgent.nextCodeBlock',
				title: localize2('interactive.nextCodeBlock.label', "Next Code Block"),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.PageDown,
					mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.PageDown, },
					weight: KeybindingWeight.WorkbenchContrib,
					when: CONTEXT_IN_CHAT_SESSION,
				},
				precondition: CONTEXT_CHAT_ENABLED,
				f1: true,
				category: CHAT_CATEGORY,
			});
		}

		run(accessor: ServicesAccessor, ..._args: any[]) {
			navigateCodeBlocks(accessor);
		}
	});

	registerAction2(class PreviousCodeBlockAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.aideAgent.previousCodeBlock',
				title: localize2('interactive.previousCodeBlock.label', "Previous Code Block"),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.PageUp,
					mac: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.PageUp, },
					weight: KeybindingWeight.WorkbenchContrib,
					when: CONTEXT_IN_CHAT_SESSION,
				},
				precondition: CONTEXT_CHAT_ENABLED,
				f1: true,
				category: CHAT_CATEGORY,
			});
		}

		run(accessor: ServicesAccessor, ...args: any[]) {
			navigateCodeBlocks(accessor, true);
		}
	});
}

function getContextFromEditor(editor: ICodeEditor, accessor: ServicesAccessor): ICodeBlockActionContext | undefined {
	const chatWidgetService = accessor.get(IAideAgentWidgetService);
	const chatCodeBlockContextProviderService = accessor.get(IAideAgentCodeBlockContextProviderService);
	const model = editor.getModel();
	if (!model) {
		return;
	}

	const widget = chatWidgetService.lastFocusedWidget;
	const codeBlockInfo = widget?.getCodeBlockInfoForEditor(model.uri);
	if (!codeBlockInfo) {
		for (const provider of chatCodeBlockContextProviderService.providers) {
			const context = provider.getCodeBlockContext(editor);
			if (context) {
				return context;
			}
		}
		return;
	}

	return {
		element: codeBlockInfo.element,
		codeBlockIndex: codeBlockInfo.codeBlockIndex,
		code: editor.getValue(),
		languageId: editor.getModel()!.getLanguageId(),
		codemapperUri: codeBlockInfo.codemapperUri
	};
}

export function registerChatCodeCompareBlockActions() {

	abstract class ChatCompareCodeBlockAction extends Action2 {
		run(accessor: ServicesAccessor, ...args: any[]) {
			const context = args[0];
			if (!isCodeCompareBlockActionContext(context)) {
				return;
				// TODO@jrieken derive context
			}

			return this.runWithContext(accessor, context);
		}

		abstract runWithContext(accessor: ServicesAccessor, context: ICodeCompareBlockActionContext): any;
	}

	registerAction2(class ApplyEditsCompareBlockAction extends ChatCompareCodeBlockAction {
		constructor() {
			super({
				id: 'workbench.action.aideAgent.applyCompareEdits',
				title: localize2('interactive.compare.apply', "Apply Edits"),
				f1: false,
				category: CHAT_CATEGORY,
				icon: Codicon.check,
				precondition: ContextKeyExpr.and(EditorContextKeys.hasChanges, CONTEXT_CHAT_EDIT_APPLIED.negate()),
				menu: {
					id: MenuId.AideAgentCompareBlock,
					group: 'navigation',
					order: 1,
				}
			});
		}

		async runWithContext(accessor: ServicesAccessor, context: ICodeCompareBlockActionContext): Promise<any> {

			const editorService = accessor.get(IEditorService);
			const instaService = accessor.get(IInstantiationService);

			const editor = instaService.createInstance(DefaultChatTextEditor);
			await editor.apply(context.element, context.edit, context.diffEditor);

			await editorService.openEditor({
				resource: context.edit.uri,
				options: { revealIfVisible: true },
			});
		}
	});

	registerAction2(class DiscardEditsCompareBlockAction extends ChatCompareCodeBlockAction {
		constructor() {
			super({
				id: 'workbench.action.aideAgent.discardCompareEdits',
				title: localize2('interactive.compare.discard', "Discard Edits"),
				f1: false,
				category: CHAT_CATEGORY,
				icon: Codicon.trash,
				precondition: ContextKeyExpr.and(EditorContextKeys.hasChanges, CONTEXT_CHAT_EDIT_APPLIED.negate()),
				menu: {
					id: MenuId.AideAgentCompareBlock,
					group: 'navigation',
					order: 2,
				}
			});
		}

		async runWithContext(accessor: ServicesAccessor, context: ICodeCompareBlockActionContext): Promise<any> {
			const instaService = accessor.get(IInstantiationService);
			const editor = instaService.createInstance(DefaultChatTextEditor);
			editor.discard(context.element, context.edit);
		}
	});
}
