import { CustomEditor, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	abortBackgroundRun,
	getBackgroundRun,
	listBackgroundRuns,
	subscribeBackgroundRuns,
	type BackgroundRun,
} from "./background-runs.ts";

export type SubagentPanelStatus = "running" | "done" | "failed";

export interface SubagentPanelUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentPanelRow {
	id: string;
	sessionId: string;
	name: string;
	model: string;
	status: SubagentPanelStatus;
	tool?: string;
	usage: SubagentPanelUsage;
	nestedCount: number;
	task: string;
	startedAt?: number;
	stopRequested: boolean;
}

export interface SubagentPanelRowInput {
	id: string;
	sessionId?: string;
	name?: string;
	agent?: string;
	model?: string;
	status?: SubagentPanelStatus;
	tool?: string;
	usage?: Partial<SubagentPanelUsage>;
	nestedCount?: number;
	task?: string;
	startedAt?: number;
	stopRequested?: boolean;
}

export interface SubagentPanelRowUpdate {
	sessionId?: string;
	name?: string;
	model?: string;
	status?: SubagentPanelStatus;
	tool?: string;
	usage?: Partial<SubagentPanelUsage>;
	nestedCount?: number;
	task?: string;
	startedAt?: number;
	stopRequested?: boolean;
}

/**
 * The small interface used by a producer of subagent status events.
 * Producers do not need to know anything about the TUI or background registry.
 */
export interface SubagentPanelSink {
	add(row: SubagentPanelRowInput | string, name?: string, model?: string, task?: string): void;
	update(id: string, patch: SubagentPanelRowUpdate): void;
	finish(id: string): void;
}

export interface SubagentPanelController extends SubagentPanelSink {
	addRow(row: SubagentPanelRowInput | string, name?: string, model?: string, task?: string): void;
	updateRow(id: string, patch: SubagentPanelRowUpdate): void;
	finishRow(id: string): void;
	enterPanelMode(): void;
	exitPanelMode(): void;
	setPanelMode(active: boolean): void;
	togglePanelMode(): boolean;
	isPanelModeActive(): boolean;
	getRows(): readonly SubagentPanelRow[];
	getSelectedRow(): Readonly<SubagentPanelRow> | undefined;
	getSelectedIndex(): number;
	setSelectedIndex(index: number): void;
	selectNext(): void;
	selectPrevious(): void;
	handleInput(data: string): TerminalInputResult | undefined;
	stopSelected(): boolean;
	syncBackgroundRuns(): void;
	dispose(): void;
}

export interface TerminalInputResult {
	consume?: boolean;
	data?: string;
}

export interface SubagentPanelTheme {
	fg(color: ThemeColor, text: string): string;
	bg(color: "selectedBg", text: string): string;
	bold(text: string): string;
}

export type SubagentPanelWidget = (
	tui: TUI,
	theme: Theme,
) => Component & { dispose?(): void };

export interface SubagentPanelUI {
	onTerminalInput?(handler: (data: string) => TerminalInputResult | undefined): () => void;
	setEditorComponent?(factory: (tui: any, theme: any, keybindings: any) => any): void;
	getEditorComponent?(): unknown;
	setWidget(
		key: string,
		content: string[] | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

export interface SubagentPanelContext {
	mode?: string;
	hasUI?: boolean;
	ui: SubagentPanelUI;
}

class SubagentPanelEditor extends CustomEditor {
	private readonly panelInput: (data: string) => TerminalInputResult | undefined;

	constructor(tui: any, theme: any, keybindings: any, panelInput: (data: string) => TerminalInputResult | undefined) {
		super(tui, theme, keybindings);
		this.panelInput = panelInput;
	}

	handleInput(data: string): void {
		const result = this.panelInput(data);
		if (result?.consume) return;
		super.handleInput(result?.data ?? data);
	}
}

export interface CreateSubagentPanelOptions {
	ui?: SubagentPanelUI;
	widgetKey?: string;
	autoActivate?: boolean;
	syncBackgroundRuns?: boolean;
	stopRun?: (sessionId: string) => boolean;
	getRun?: (sessionId: string) => BackgroundRun | undefined;
}

const DEFAULT_WIDGET_KEY = "subagent-panel";
const MAX_RETAINED_ROWS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function normalizeUsage(usage: Partial<SubagentPanelUsage> | undefined): SubagentPanelUsage {
	return {
		input: finiteNumber(usage?.input),
		output: finiteNumber(usage?.output),
		cacheRead: finiteNumber(usage?.cacheRead),
		cacheWrite: finiteNumber(usage?.cacheWrite),
		cost: finiteNumber(usage?.cost),
		contextTokens: finiteNumber(usage?.contextTokens),
		turns: finiteNumber(usage?.turns),
	};
}

function mergeUsage(current: SubagentPanelUsage, patch: Partial<SubagentPanelUsage>): SubagentPanelUsage {
	return {
		input: finiteNumber(patch.input, current.input),
		output: finiteNumber(patch.output, current.output),
		cacheRead: finiteNumber(patch.cacheRead, current.cacheRead),
		cacheWrite: finiteNumber(patch.cacheWrite, current.cacheWrite),
		cost: finiteNumber(patch.cost, current.cost),
		contextTokens: finiteNumber(patch.contextTokens, current.contextTokens),
		turns: finiteNumber(patch.turns, current.turns),
	};
}

function toRow(input: SubagentPanelRowInput): SubagentPanelRow {
	const sessionId = input.sessionId?.trim() || input.id;
	return {
		id: input.id,
		sessionId,
		name: input.name?.trim() || input.agent?.trim() || input.id,
		model: input.model?.trim() || "(pending)",
		status: input.status ?? "running",
		tool: input.tool,
		usage: normalizeUsage(input.usage),
		nestedCount: finiteNumber(input.nestedCount),
		task: input.task?.trim() || "(no task)",
		startedAt: input.startedAt,
		stopRequested: input.stopRequested ?? false,
	};
}

function updateRow(row: SubagentPanelRow, patch: SubagentPanelRowUpdate): void {
	if (patch.sessionId !== undefined) row.sessionId = patch.sessionId.trim() || row.sessionId;
	if (patch.name !== undefined && patch.name.trim()) row.name = patch.name.trim();
	if (patch.model !== undefined && patch.model.trim()) row.model = patch.model.trim();
	if (patch.status !== undefined) row.status = patch.status;
	if (Object.hasOwn(patch, "tool")) row.tool = patch.tool;
	if (patch.usage !== undefined) row.usage = mergeUsage(row.usage, patch.usage);
	if (patch.nestedCount !== undefined) row.nestedCount = finiteNumber(patch.nestedCount);
	if (patch.task !== undefined && patch.task.trim()) row.task = patch.task.trim();
	if (patch.startedAt !== undefined) row.startedAt = patch.startedAt;
	if (patch.stopRequested !== undefined) row.stopRequested = patch.stopRequested;
}

function getResult(run: unknown): Record<string, unknown> | undefined {
	if (!isRecord(run) || !isRecord(run.result)) return undefined;
	return run.result;
}

function runUsage(run: unknown): Partial<SubagentPanelUsage> | undefined {
	const result = getResult(run);
	return isRecord(result?.usage) ? (result.usage as Partial<SubagentPanelUsage>) : undefined;
}

function runModel(run: unknown): string | undefined {
	const result = getResult(run);
	return typeof result?.model === "string" ? result.model : undefined;
}

function statusFromRun(run: unknown): SubagentPanelStatus {
	if (isRecord(run) && run.status === "done") return "done";
	if (isRecord(run) && run.status === "failed") return "failed";
	return "running";
}

function rowInputFromRun(run: BackgroundRun): SubagentPanelRowInput {
	return {
		id: run.sessionId,
		sessionId: run.sessionId,
		name: run.agent,
		task: run.task,
		status: statusFromRun(run),
		startedAt: run.startedAt,
		model: runModel(run),
		usage: runUsage(run),
		nestedCount: 0,
		stopRequested: run.stopRequested,
	};
}

function formatTokenCount(value: number): string {
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`;
}

function formatElapsed(startedAt: number | undefined): string {
	if (!startedAt || !Number.isFinite(startedAt)) return "";
	const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
	if (elapsed < 60) return `${elapsed}s`;
	const minutes = Math.floor(elapsed / 60);
	const seconds = elapsed % 60;
	if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatSubagentPanelUsage(usage: SubagentPanelUsage): string {
	const cache = usage.cacheRead + usage.cacheWrite;
	const cacheText = cache > 0 ? ` cache ${formatTokenCount(cache)}` : "";
	const costText = usage.cost > 0 ? ` $${usage.cost.toFixed(4)}` : "";
	return `in ${formatTokenCount(usage.input)} out ${formatTokenCount(usage.output)}${cacheText} ${Math.round(usage.turns)}t${costText}`;
}

function statusIcon(status: SubagentPanelStatus): string {
	if (status === "done") return "✓";
	if (status === "failed") return "✗";
	return "⏳";
}

function styled(
	theme: SubagentPanelTheme | undefined,
	color: ThemeColor,
	text: string,
): string {
	return theme ? theme.fg(color, text) : text;
}

function fit(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "");
}

function selectedLine(
	text: string,
	width: number,
	selected: boolean,
	theme: SubagentPanelTheme | undefined,
): string {
	const line = fit(text, width);
	return selected && theme ? theme.bg("selectedBg", line) : line;
}

export interface RenderSubagentPanelOptions {
	selectedIndex?: number;
	active?: boolean;
	theme?: SubagentPanelTheme;
}

/** Render the panel without a TUI. Every returned line fits the requested width. */
export function renderSubagentPanelLines(
	rows: readonly SubagentPanelRow[],
	width: number,
	options: RenderSubagentPanelOptions = {},
): string[] {
	if (rows.length === 0) return [];
	const selectedIndex = options.selectedIndex ?? -1;
	const maxRows = 5;
	const selectedWindowIndex = options.active && selectedIndex >= 0 ? selectedIndex : 0;
	const start = rows.length <= maxRows
		? 0
		: Math.min(Math.max(0, selectedWindowIndex - Math.floor(maxRows / 2)), rows.length - maxRows);
	const end = Math.min(rows.length, start + maxRows);
	const lines: string[] = [];
	const hint = options.active
		? " | arrows select | x stop | Esc close"
		: " | F8 focus";
	lines.push(fit(styled(options.theme, "accent", `Subagents (${rows.length})${hint}`), width));
	if (start > 0) lines.push(fit(styled(options.theme, "dim", `  ↑ ${start} earlier`), width));

	rows.slice(start, end).forEach((row, offset) => {
		const index = start + offset;
		const selected = options.active === true && index === selectedIndex;
		const displayedStatus = row.stopRequested && row.status === "running" ? "stopping" : row.status;
		const tool = row.tool && row.tool !== "idle" ? `· ${row.tool}` : "";
		const model = row.model || "(pending)";
		const elapsed = formatElapsed(row.startedAt);
		const status = displayedStatus === "running" ? "" : displayedStatus;
		const summary = [
			selected ? ">" : " ",
			statusIcon(row.status),
			row.name,
			status,
			formatSubagentPanelUsage(row.usage),
			elapsed ? `${elapsed}` : "",
			`[${model}]`,
			tool,
			...(row.nestedCount > 0 ? [`+${row.nestedCount} nested`] : []),
		].filter(Boolean).join(" ");
		lines.push(selectedLine(styled(options.theme, selected ? "accent" : "text", summary), width, selected, options.theme));
		const task = `  task: ${row.task.replace(/\s+/g, " ")}`;
		lines.push(selectedLine(styled(options.theme, "muted", task), width, selected, options.theme));
	});
	if (end < rows.length) lines.push(fit(styled(options.theme, "dim", `  ↓ ${rows.length - end} more`), width));
	return lines;
}

function inputIs(data: string, key: Parameters<typeof matchesKey>[1]): boolean {
	return data === key || matchesKey(data, key);
}

export function createSubagentPanelController(
	options: CreateSubagentPanelOptions = {},
): SubagentPanelController {
	const rows = new Map<string, SubagentPanelRow>();
	const watchedRuns = new WeakSet<BackgroundRun>();
	const activeRuns = new Map<string, BackgroundRun>();
	const ui = options.ui;
	const widgetKey = options.widgetKey ?? DEFAULT_WIDGET_KEY;
	const stopRun = options.stopRun ?? abortBackgroundRun;
	const getRun = options.getRun ?? getBackgroundRun;
	const observeBackgroundEvents = Boolean(ui || options.syncBackgroundRuns);
	let selectedIndex = -1;
	let panelMode = options.autoActivate ?? false;
	let disposed = false;
	let widgetInstalled = false;
	let activeComponent: (Component & { dispose?(): void }) | undefined;
	let requestRender: (() => void) | undefined;
	let elapsedTimer: NodeJS.Timeout | undefined;
	let editorInstalled = false;
	let previousEditorFactory: unknown;
	let panelEditorFactory: ((tui: any, theme: any, keybindings: any) => any) | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let unsubscribeRuns: (() => void) | undefined;

	const widgetFactory: SubagentPanelWidget = (tui, theme) => {
		requestRender = () => tui.requestRender();
		const component: Component & { dispose?(): void } = {
			render(width) {
				return renderSubagentPanelLines([...rows.values()], width, {
					selectedIndex,
					active: panelMode,
					theme,
				});
			},
			invalidate() {
				// Rows are rendered from current state, so no cache is required.
			},
			dispose() {
				if (activeComponent === component) activeComponent = undefined;
			},
		};
		activeComponent = component;
		return component;
	};

	const refreshElapsedTimer = (): void => {
		const hasRunningRows = [...rows.values()].some((row) => row.status === "running");
		if (!ui || !hasRunningRows) {
			if (elapsedTimer) clearInterval(elapsedTimer);
			elapsedTimer = undefined;
			return;
		}
		if (elapsedTimer) return;
		elapsedTimer = setInterval(() => {
			if (disposed) return;
			if ([...rows.values()].some((row) => row.status === "running")) requestRender?.();
			else {
				clearInterval(elapsedTimer);
				elapsedTimer = undefined;
			}
		}, 1000);
		elapsedTimer.unref?.();
	};

	const refresh = (): void => {
		if (disposed) return;
		refreshElapsedTimer();
		if (rows.size === 0) {
			if (widgetInstalled) {
				ui?.setWidget(widgetKey, undefined);
				widgetInstalled = false;
			}
			return;
		}
		if (ui && !widgetInstalled) {
			ui.setWidget(widgetKey, widgetFactory, { placement: "aboveEditor" });
			widgetInstalled = true;
		} else {
			requestRender?.();
		}
	};

	const trimRows = (): void => {
		while (rows.size > MAX_RETAINED_ROWS) {
			const entries = [...rows.entries()];
			let candidateIndex = entries.findIndex(([, row], index) => row.status !== "running" && index !== selectedIndex);
			if (candidateIndex === -1) candidateIndex = entries.findIndex(([, row]) => row.status !== "running");
			if (candidateIndex === -1) return;
			const [candidateId] = entries[candidateIndex];
			rows.delete(candidateId);
			activeRuns.delete(candidateId);
			if (candidateIndex < selectedIndex) selectedIndex--;
			else if (candidateIndex === selectedIndex) selectedIndex = Math.min(selectedIndex, rows.size - 1);
		}
	};

	const clampSelection = (): void => {
		if (rows.size === 0) {
			selectedIndex = -1;
			return;
		}
		selectedIndex = Math.max(0, Math.min(selectedIndex < 0 ? 0 : selectedIndex, rows.size - 1));
	};

	const remove = (id: string): void => {
		const index = [...rows.keys()].indexOf(id);
		if (index < 0) return;
		rows.delete(id);
		activeRuns.delete(id);
		if (index < selectedIndex) selectedIndex--;
		else if (index === selectedIndex) selectedIndex = Math.min(selectedIndex, rows.size - 1);
		clampSelection();
		refresh();
	};

	const rowAt = (index: number): SubagentPanelRow | undefined => {
		if (index < 0 || index >= rows.size) return undefined;
		return [...rows.values()][index];
	};

	const watchRun = (row: SubagentPanelRow): void => {
		const run = getRun(row.sessionId);
		if (!run || watchedRuns.has(run)) return;
		watchedRuns.add(run);
		activeRuns.set(row.id, run);
		if (observeBackgroundEvents) return;
		void run.promise.then(() => {
			if (disposed || activeRuns.get(row.id) !== run || !rows.has(row.id)) return;
			remove(row.id);
		});
	};

	const add = (inputOrId: SubagentPanelRowInput | string, name?: string, model?: string, task?: string): void => {
		if (disposed) return;
		const input: SubagentPanelRowInput = typeof inputOrId === "string"
			? { id: inputOrId, name, model, task }
			: inputOrId;
		const existing = rows.get(input.id);
		if (existing) {
			const restarting = existing.status !== "running" && (input.status === undefined || input.status === "running");
			if (restarting) {
				existing.status = "running";
				existing.model = input.model?.trim() || "(pending)";
				existing.tool = input.tool;
				existing.usage = normalizeUsage(input.usage);
				existing.nestedCount = finiteNumber(input.nestedCount);
				existing.stopRequested = false;
				existing.startedAt = input.startedAt ?? Date.now();
			}
			updateRow(existing, input);
			watchRun(existing);
			refresh();
			return;
		}
		rows.set(input.id, toRow(input));
		trimRows();
		clampSelection();
		const added = rows.get(input.id);
		if (added) watchRun(added);
		refresh();
	};

	const update = (id: string, patch: SubagentPanelRowUpdate): void => {
		if (disposed) return;
		const row = rows.get(id);
		if (!row) return;
		updateRow(row, patch);
		if (row.status !== "running") {
			remove(id);
			return;
		}
		watchRun(row);
		refresh();
	};

	const finish = (id: string): void => {
		if (disposed) return;
		remove(id);
	};

	const enterPanelMode = (): void => {
		if (rows.size > 0) clampSelection();
		panelMode = true;
		refresh();
	};

	const exitPanelMode = (): void => {
		panelMode = false;
		refresh();
	};

	const setPanelMode = (active: boolean): void => {
		if (active) enterPanelMode();
		else exitPanelMode();
	};

	const select = (delta: number): void => {
		if (rows.size === 0) return;
		clampSelection();
		selectedIndex = Math.max(0, Math.min(rows.size - 1, selectedIndex + delta));
		refresh();
	};

	const stopSelected = (): boolean => {
		const row = rowAt(selectedIndex);
		if (!row || row.status !== "running") return false;
		if (row.stopRequested) {
			ui?.notify?.(`Stop already requested for "${row.name}".`, "info");
			return false;
		}
		if (!getRun(row.sessionId)) {
			ui?.notify?.("Foreground subagents stop with Escape, which interrupts the current turn.", "warning");
			return false;
		}
		const stopped = stopRun(row.sessionId);
		if (stopped) {
			row.stopRequested = true;
			refresh();
		} else {
			ui?.notify?.(`Could not stop subagent "${row.name}".`, "warning");
		}
		return stopped;
	};

	const handleInput = (data: string): TerminalInputResult | undefined => {
		if (disposed || !panelMode) return undefined;
		if (inputIs(data, Key.up)) {
			select(-1);
			return { consume: true };
		}
		if (inputIs(data, Key.down)) {
			select(1);
			return { consume: true };
		}
		if (inputIs(data, Key.left) || inputIs(data, Key.right)) {
			return { consume: true };
		}
		if (inputIs(data, Key.escape) || inputIs(data, "f8")) {
			exitPanelMode();
			return { consume: true };
		}
		if (inputIs(data, Key.enter)) return { consume: true };
		if (inputIs(data, "x")) {
			stopSelected();
			return { consume: true };
		}
		// Leave navigation mode before forwarding any unrelated key. This keeps
		// Pi's selectors and other extension dialogs from losing their input.
		exitPanelMode();
		return undefined;
	};

	if (ui?.setEditorComponent && ui.getEditorComponent) {
		previousEditorFactory = ui.getEditorComponent();
		if (previousEditorFactory === undefined) {
			panelEditorFactory = (tui, theme, keybindings) =>
				new SubagentPanelEditor(tui, theme, keybindings, handleInput);
			ui.setEditorComponent(panelEditorFactory);
			editorInstalled = true;
		}
	}

	const syncBackgroundRuns = (): void => {
		for (const run of listBackgroundRuns()) {
			if (run.status === "running") add(rowInputFromRun(run));
		}
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		unsubscribeInput?.();
		unsubscribeInput = undefined;
		if (editorInstalled && (!ui?.getEditorComponent || ui.getEditorComponent() === panelEditorFactory)) {
			ui?.setEditorComponent?.(previousEditorFactory as any);
		}
		editorInstalled = false;
		panelEditorFactory = undefined;
		unsubscribeRuns?.();
		unsubscribeRuns = undefined;
		if (elapsedTimer) clearInterval(elapsedTimer);
		elapsedTimer = undefined;
		if (widgetInstalled) ui?.setWidget(widgetKey, undefined);
		widgetInstalled = false;
		activeComponent?.dispose?.();
		activeComponent = undefined;
		requestRender = undefined;
		rows.clear();
		activeRuns.clear();
	};

	const controller: SubagentPanelController = {
		add: add as (row: SubagentPanelRowInput | string, name?: string, model?: string, task?: string) => void,
		update,
		finish,
		addRow: (row, name, model, task) => add(row, name, model, task),
		updateRow: update,
		finishRow: finish,
		enterPanelMode,
		exitPanelMode,
		setPanelMode,
		togglePanelMode: () => {
			setPanelMode(!panelMode);
			return panelMode;
		},
		isPanelModeActive: () => panelMode,
		getRows: () => [...rows.values()].map((row) => ({ ...row, usage: { ...row.usage } })),
		getSelectedRow: () => {
			const row = rowAt(selectedIndex);
			return row ? { ...row, usage: { ...row.usage } } : undefined;
		},
		getSelectedIndex: () => selectedIndex,
		setSelectedIndex: (index) => {
			selectedIndex = index;
			clampSelection();
			refresh();
		},
		selectNext: () => select(1),
		selectPrevious: () => select(-1),
		handleInput,
		stopSelected,
		syncBackgroundRuns,
		dispose,
	};

	// Keep the raw listener only as a compatibility fallback for Pi versions or
	// other extensions that do not expose a usable custom editor slot.
	if (!editorInstalled && ui?.onTerminalInput) unsubscribeInput = ui.onTerminalInput(handleInput);
	if (ui || options.syncBackgroundRuns) {
		unsubscribeRuns = subscribeBackgroundRuns((event) => {
			if (event.type === "registered") add(rowInputFromRun(event.run));
			else if (activeRuns.get(event.run.sessionId) && activeRuns.get(event.run.sessionId) !== event.run) return;
			else if (event.type === "settled") remove(event.run.sessionId);
			else if (event.type === "stopRequested") update(event.run.sessionId, { stopRequested: true });
			else update(event.run.sessionId, {
				status: statusFromRun(event.run),
				model: runModel(event.run),
				usage: runUsage(event.run),
				stopRequested: event.run.stopRequested,
			});
		});
	}
	if (options.syncBackgroundRuns) syncBackgroundRuns();
	refresh();
	return controller;
}

let activePanel: SubagentPanelController | undefined;

/** Create the panel for the current Pi session. Repeated calls replace the old panel. */
export function initializeSubagentPanel(ctx: SubagentPanelContext): SubagentPanelController {
	disposeSubagentPanel();
	const useTui = ctx.mode === undefined || ctx.mode === "tui";
	const controller = createSubagentPanelController({
		ui: useTui && ctx.hasUI !== false ? ctx.ui : undefined,
		syncBackgroundRuns: useTui && ctx.hasUI !== false,
	});
	activePanel = controller;
	return controller;
}

export function getSubagentPanel(): SubagentPanelController | undefined {
	return activePanel;
}

export function disposeSubagentPanel(): void {
	activePanel?.dispose();
	activePanel = undefined;
}
