/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

import { detectMultiline } from './detect-multiline';
import {
	getFirstLine,
	getLastLine,
	getNextNonEmptyLine,
	getPositionAfterTextInsertion,
	getPrevNonEmptyLine,
	lines,
} from './text-processing';
import { getMatchingSuffixLength } from './text-processing/process-inline-completions';
import { LoggingService } from './logger';

export interface DocumentContext extends DocumentDependentContext, LinesContext {
	position: vscode.Position;
	multilineTrigger: string | null;
	multilineTriggerPosition: vscode.Position | null;
	/**
	 * A temporary workaround for the fact that we cannot modify `TextDocument` text.
	 * Having these fields set on a `DocumentContext` means we can still get the full
	 * document text in the `parse-completion` function with the "virtually" inserted
	 * completion text.
	 *
	 * TODO(valery): we need a better abstraction that would allow us to mutate
	 * the `TextDocument` text in memory without actually pasting it into the `TextDocument`
	 * and that would not require copy-pasting and modifying the whole document text
	 * on every completion update or new virtual completion creation.
	 */
	injectedCompletionText?: string;
	positionWithoutInjectedCompletionText?: vscode.Position;
}

export interface DocumentDependentContext {
	prefix: string;
	suffix: string;
	/**
	 * This is set when the document context is looking at the selected item in the
	 * suggestion widget and injects the item into the prefix.
	 */
	injectedPrefix: string | null;
}

interface GetCurrentDocContextParams {
	document: vscode.TextDocument;
	position: vscode.Position;
	/* A number representing the maximum length of the prefix to get from the document. */
	maxPrefixLength: number;
	/* A number representing the maximum length of the suffix to get from the document. */
	maxSuffixLength: number;
	context?: vscode.InlineCompletionContext;
	dynamicMultilineCompletions: boolean;
}

/**
 * Get the current document context based on the cursor position in the current document.
 */
export function getCurrentDocContext(params: GetCurrentDocContextParams, logger: LoggingService, spanId: string): DocumentContext {
	const {
		document,
		position,
		maxPrefixLength,
		maxSuffixLength,
		context,
		// this is always set to true for now, but we might want to change that in the future
		dynamicMultilineCompletions,
	} = params;
	const offset = document.offsetAt(position);

	// we get the complete prefix and the complete suffix
	const completePrefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
	const completeSuffix = document.getText(
		new vscode.Range(position, document.positionAt(document.getText().length))
	);

	// Patch the document to contain the selected completion from the popup dialog already
	let completePrefixWithContextCompletion = completePrefix;
	let injectedPrefix = null;
	if (context?.selectedCompletionInfo) {
		const { range, text } = context.selectedCompletionInfo;
		// A selected completion info attempts to replace the specified range with the inserted text
		//
		// We assume that the end of the range equals the current position, otherwise this would not
		// inject a prefix
		if (range.end.character === position.character && range.end.line === position.line) {
			const lastLine = lines(completePrefix).at(-1)!;
			const beforeLastLine = completePrefix.slice(0, -lastLine.length);
			completePrefixWithContextCompletion =
				beforeLastLine + lastLine.slice(0, range.start.character) + text;
			injectedPrefix = completePrefixWithContextCompletion.slice(completePrefix.length);
			if (injectedPrefix === '') {
				injectedPrefix = null;
			}
		} else {
			console.warn('The selected completion info does not match the current position');
		}
	}

	const prefixLines = lines(completePrefixWithContextCompletion);
	const suffixLines = lines(completeSuffix);

	let prefix: string;
	// we are deriving the prefix from the complete prefix
	if (offset > maxPrefixLength) {
		let total = 0;
		let startLine = prefixLines.length;
		for (let i = prefixLines.length - 1; i >= 0; i--) {
			if (total + prefixLines[i].length > maxPrefixLength) {
				break;
			}
			startLine = i;
			total += prefixLines[i].length;
		}
		prefix = prefixLines.slice(startLine).join('\n');
	} else {
		prefix = prefixLines.join('\n');
	}

	// we are deriving the suffix from the complete suffix
	let totalSuffix = 0;
	let endLine = 0;
	for (let i = 0; i < suffixLines.length; i++) {
		if (totalSuffix + suffixLines[i].length > maxSuffixLength) {
			break;
		}
		endLine = i + 1;
		totalSuffix += suffixLines[i].length;
	}
	const suffix = suffixLines.slice(0, endLine).join('\n');

	return getDerivedDocContext({
		position,
		languageId: document.languageId,
		dynamicMultilineCompletions,
		documentDependentContext: {
			prefix,
			suffix,
			injectedPrefix,
		},
	}, logger, spanId);
}

interface GetDerivedDocContextParams {
	languageId: string;
	position: vscode.Position;
	documentDependentContext: DocumentDependentContext;
	dynamicMultilineCompletions: boolean;
}

/**
 * Calculates `DocumentContext` based on the existing prefix and suffix.
 * Used if the document context needs to be calculated for the updated text but there's no `document` instance for that.
 */
export function getDerivedDocContext(params: GetDerivedDocContextParams, logger: LoggingService, spanId: string): DocumentContext {
	const { position, documentDependentContext, languageId, dynamicMultilineCompletions } = params;
	const linesContext = getLinesContext(documentDependentContext);

	const { multilineTrigger, multilineTriggerPosition } = detectMultiline({
		docContext: { ...linesContext, ...documentDependentContext },
		languageId,
		dynamicMultilineCompletions,
		position,
	}, logger, spanId);

	return {
		...documentDependentContext,
		...linesContext,
		position,
		multilineTrigger,
		multilineTriggerPosition,
	};
}

/**
 * Inserts a completion into a specific document context and computes the updated cursor position.
 *
 * This will insert the completion at the `position` outlined in the document context and will
 * replace the whole rest of the line with the completion. This means that if you have content in
 * the sameLineSuffix, it will be an empty string afterwards.
 *
 *
 * NOTE: This will always move the position to the _end_ of the line that the text was inserted at,
 *       regardless of whether the text was inserted before the sameLineSuffix.
 *
 *       When inserting `2` into: `f(1, █);`, the document context will look like this `f(1, 2);█`
 */
interface InsertIntoDocContextParams {
	docContext: DocumentContext;
	insertText: string;
	languageId: string;
	dynamicMultilineCompletions: boolean;
}

export function insertIntoDocContext(params: InsertIntoDocContextParams, logger: LoggingService, spanId: string): DocumentContext {
	const {
		insertText,
		languageId,
		dynamicMultilineCompletions,
		docContext,
		docContext: { position, prefix, suffix, currentLineSuffix },
	} = params;

	const updatedPosition = getPositionAfterTextInsertion(position, insertText);

	const updatedDocContext = getDerivedDocContext({
		languageId,
		position: updatedPosition,
		dynamicMultilineCompletions,
		documentDependentContext: {
			prefix: prefix + insertText,
			// Remove the characters that are being replaced by the completion
			// to reduce the chances of breaking the parse tree with redundant symbols.
			suffix: suffix.slice(getMatchingSuffixLength(insertText, currentLineSuffix)),
			// we do not inject anything here because its not required yet, we are at the start
			// of the completion
			injectedPrefix: null,
		},
	}, logger, spanId);

	updatedDocContext.positionWithoutInjectedCompletionText =
		updatedDocContext.positionWithoutInjectedCompletionText || docContext.position;
	updatedDocContext.injectedCompletionText = (docContext.injectedCompletionText || '') + insertText;

	return updatedDocContext;
}

export interface LinesContext {
	/** Text before the cursor on the same line. */
	currentLinePrefix: string;
	/** Text after the cursor on the same line. */
	currentLineSuffix: string;

	prevNonEmptyLine: string;
	nextNonEmptyLine: string;
}

interface GetLinesContextParams {
	prefix: string;
	suffix: string;
}

function getLinesContext(params: GetLinesContextParams): LinesContext {
	const { prefix, suffix } = params;

	const currentLinePrefix = getLastLine(prefix);
	const currentLineSuffix = getFirstLine(suffix);

	const prevNonEmptyLine = getPrevNonEmptyLine(prefix);
	const nextNonEmptyLine = getNextNonEmptyLine(suffix);

	return {
		currentLinePrefix,
		currentLineSuffix,
		prevNonEmptyLine,
		nextNonEmptyLine,
	};
}
