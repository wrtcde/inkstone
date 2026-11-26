import { StateEffect, StateField, EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { searchPanelOpen } from '@codemirror/search';
import { parseWikiTarget, renderMarkdownBlocks, type Heading, type MarkdownBlock } from '../lib/markdown/renderer';
import { enhancePreview, renderPendingMermaid, toggleCodeBlockCollapse } from '../lib/markdown/enhance';
import { resolveNoteEmbeds } from '../lib/markdown/embeds';
import { useSession } from '../store/session';
import { t } from '../lib/i18n';
import { decodeDataValue } from '../lib/markdown/data-attr';
import { findNoteByTitle, useNotes } from '../store/notes';
import { useUi } from '../store/ui';
import { selectMarkdownTab, moveMarkdownTabFocus } from '../features/preview/markdown-tabs';

const focusChanged = StateEffect.define<boolean>();
const refresh = StateEffect.define<boolean>();

// A line consisting solely of image references. Image-only blocks stay
// graphical in the editing surface: their Markdown source is never exposed.
const IMAGE_LINE_RE = /^(?:\s*!\[[^\]]*\]\([^)]*\))+\s*$/;
function isImageOnlyBlock(state: EditorState, block: MarkdownBlock): boolean {
    const to = Math.min(block.endLine, state.doc.lines);
    if (to < block.startLine + 1) return false;
    for (let n = block.startLine + 1; n <= to; n++) {
        if (!IMAGE_LINE_RE.test(state.doc.line(n).text)) return false;
    }
    return true;
}

class RenderedBlock extends WidgetType {
    constructor(readonly block: MarkdownBlock, readonly source: string, readonly revision: number, readonly title: string) { super(); }
    eq(other: RenderedBlock) {
        return this.block.html === other.block.html && this.block.startLine === other.block.startLine
            && this.block.endLine === other.block.endLine && this.revision === other.revision && this.title === other.title
            && (!this.block.html.includes('data-embed-target') || this.source === other.source);
    }
    toDOM(view: EditorView) {
        const host = document.createElement('div');
        host.className = 'ink-prose cm-live-block';
        host.dataset.font = useSession.getState().settings.appearance.proseFont;
        host.innerHTML = this.block.html;
        host.title = t('workspace.live_preview_hint');
        let alive = true;
        const observer = new ResizeObserver(() => view.requestMeasure());
        observer.observe(host);
        cleanup.set(host, () => { alive = false; observer.disconnect(); });
        const settings = useSession.getState().settings.preview;
        const dark = document.documentElement.dataset.theme === 'dark';
        const prepare = async () => {
            await resolveNoteEmbeds(host, { currentContent: this.source, currentTitle: this.title, isCurrent: () => alive });
            if (!alive) return;
            await enhancePreview(host, { math: settings.math, mermaid: settings.mermaid, dark, codeBlockCollapseLines: 0 });
            if (alive && settings.mermaid) await renderPendingMermaid(host, dark, { isCurrent: () => alive });
            if (alive) view.requestMeasure();
        };
        void prepare().catch(() => { if (alive) view.requestMeasure(); });
        const imageBlockBlank = (event: MouseEvent): boolean => {
            if ((event.target as HTMLElement).closest('img')) return false;
            const from = this.block.startLine + 1;
            const to = Math.min(this.block.endLine, view.state.doc.lines);
            for (let n = from; n <= to; n++) {
                if (!IMAGE_LINE_RE.test(view.state.doc.line(n).text)) return false;
            }
            return host.querySelectorAll('img').length > 0;
        };
        host.addEventListener('mousedown', (event) => {
            // Keep the widget alive for image clicks: CodeMirror would otherwise
            // move the cursor on mousedown and replace the block with source
            // before the click (lightbox) handler runs.
            if ((event.target as HTMLElement).closest('img') || imageBlockBlank(event)) {
                event.preventDefault();
                event.stopPropagation();
            }
        });
        host.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            const checkbox = target.closest<HTMLInputElement>('input[data-task-line]');
            if (checkbox) {
                if (checkbox.disabled || checkbox.closest('.note-embed-body')) return;
                const n = Number(checkbox.dataset.taskLine) + 1;
                if (n > 0 && n <= view.state.doc.lines) {
                    const line = view.state.doc.line(n);
                    const match = /^(?:\s*>\s*)*\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(line.text);
                    if (match) {
                        const pos = line.from + match[0].length - 2;
                        view.dispatch({ changes: { from: pos, to: pos + 1, insert: match[1] === ' ' ? 'x' : ' ' }, userEvent: 'input' });
                    }
                }
                return;
            }
            const collapse = target.closest<HTMLButtonElement>('[data-code-collapse]');
            if (collapse) { toggleCodeBlockCollapse(collapse); return; }
            const tab = target.closest<HTMLButtonElement>('[data-tab-button]');
            if (tab) { event.preventDefault(); selectMarkdownTab(tab); return; }
            const copy = target.closest<HTMLButtonElement>('[data-copy]');
            if (copy) {
                event.preventDefault();
                const code = copy.closest('.code-block')?.querySelector('pre')?.textContent ?? '';
                void navigator.clipboard?.writeText(code).then(() => useUi.getState().toast({ title: t('common.copied') }))
                    .catch(() => useUi.getState().toast({ title: t('preview.could_not_copy'), tone: 'danger' }));
                return;
            }
            if (target.closest('summary')) return;
            const wiki = target.closest<HTMLElement>('[data-wikilink]');
            if (wiki && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                const parsed = parseWikiTarget(decodeDataValue(wiki.dataset.wikilink));
                const note = findNoteByTitle(parsed.noteTitle);
                if (note) void useNotes.getState().openNote(note.id);
                else if (parsed.noteTitle) void useNotes.getState().createNote({ title: parsed.noteTitle });
                return;
            }
            if ((event.metaKey || event.ctrlKey) && target.closest('a[href]')) return;
            const image = target.closest<HTMLImageElement>('img');
            if (image?.src) {
                event.preventDefault();
                useUi.getState().setLightbox({ src: image.src, alt: image.alt });
                return;
            }
            if (imageBlockBlank(event)) {
                // Clicking blank space in an image-only block (grid gaps, right
                // of the last tile, below the grid) starts a new paragraph after
                // it instead of exposing the image source.
                event.preventDefault();
                const lineNo = Math.min(this.block.endLine, view.state.doc.lines);
                const line = view.state.doc.line(lineNo);
                const next = lineNo < view.state.doc.lines ? view.state.doc.line(lineNo + 1) : null;
                const at = next && next.text === '' ? next.to : line.to;
                const insert = next && next.text === '' ? '\n' : '\n\n';
                view.dispatch({
                    changes: { from: at, insert },
                    selection: { anchor: at + insert.length },
                    userEvent: 'input',
                });
                view.focus();
                return;
            }
            event.preventDefault();
            // Preserve the source line under the pointer, including rows inside tables/lists.
            const mapped = target.closest<HTMLElement>('[data-line]');
            const n = Math.max(this.block.startLine + 1, Math.min(this.block.endLine, Number(mapped?.dataset.line ?? this.block.startLine) + 1));
            const line = view.state.doc.line(Math.min(n, view.state.doc.lines));
            view.dispatch({ selection: { anchor: line.from }, effects: focusChanged.of(true), userEvent: 'select.pointer' });
            view.focus();
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos !== null && pos >= line.from && pos <= view.state.doc.line(Math.min(this.block.endLine, view.state.doc.lines)).to)
                view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
        });
        host.addEventListener('keydown', (event) => {
            const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab-button]');
            if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); moveMarkdownTabFocus(tab, event.key); }
        });
        return host;
    }
    destroy(dom: HTMLElement) { cleanup.get(dom)?.(); cleanup.delete(dom); }
    ignoreEvent() { return true; }
}
const cleanup = new WeakMap<HTMLElement, () => void>();

interface LiveState {
    blocks: MarkdownBlock[];
    headings: Heading[];
    decorations: DecorationSet;
    focused: boolean;
    revision: number;
}

function decorate(state: EditorState, live: LiveState, title: string): DecorationSet {
    if (searchPanelOpen(state)) return Decoration.none;
    const ranges: Range<Decoration>[] = [];
    const source = state.doc.toString();
    for (const block of live.blocks) {
        if (block.startLine >= state.doc.lines || block.endLine <= block.startLine) continue;
        const from = state.doc.line(block.startLine + 1).from;
        const to = state.doc.line(Math.min(block.endLine, state.doc.lines)).to;
        const active = !isImageOnlyBlock(state, block) && state.selection.ranges.some((range) =>
            (live.focused || !range.empty) && range.from <= to && range.to >= from);
        if (active || from === to) continue;
        ranges.push(Decoration.replace({ block: true, widget: new RenderedBlock(block, source, live.revision, title) }).range(from, to));
    }
    return Decoration.set(ranges, true);
}

/** Decorations change presentation only; all editing, undo, search and saving use Markdown. */
export function livePreview(onHeadings: (headings: Heading[]) => void, getTitle: () => string = () => ''): Extension {
    const field = StateField.define<LiveState>({
        create(state) {
            const result = renderMarkdownBlocks(state.doc.toString());
            const value: LiveState = { ...result, decorations: Decoration.none, focused: false, revision: 0 };
            value.decorations = decorate(state, value, getTitle());
            return value;
        },
        update(value, tr) {
            const focused = tr.effects.find((effect) => effect.is(focusChanged));
            const refreshed = tr.effects.find((effect) => effect.is(refresh));
            const searchChanged = searchPanelOpen(tr.startState) !== searchPanelOpen(tr.state);
            if (!tr.docChanged && !tr.selection && !focused && !refreshed && !searchChanged) return value;
            // Keep typing synchronous and cheap. Reparse after a short idle window; never
            // display stale HTML for a block whose source was touched in the meantime.
            const mapped = tr.docChanged ? value.blocks.flatMap((block) => {
                const from = tr.startState.doc.line(block.startLine + 1).from;
                const to = tr.startState.doc.line(Math.min(block.endLine, tr.startState.doc.lines)).to;
                if (tr.changes.touchesRange(from, to)) return [];
                const startLine = tr.state.doc.lineAt(tr.changes.mapPos(from, 1)).number - 1;
                const delta = startLine - block.startLine;
                return [{ ...block, startLine,
                    html: delta ? block.html.replace(/(data-(?:task-)?line=")(\d+)(")/g, (_, before, line, after) => `${before}${Number(line) + delta}${after}`) : block.html,
                    endLine: tr.state.doc.lineAt(tr.changes.mapPos(to, -1)).number }];
            }) : value.blocks;
            const next = { ...value, blocks: mapped, ...(refreshed ? renderMarkdownBlocks(tr.state.doc.toString()) : {}),
                focused: focused ? focused.value : value.focused, revision: value.revision + (refreshed?.value ? 1 : 0) };
            next.decorations = decorate(tr.state, next, getTitle());
            return next;
        },
        provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
    });
    return [field, EditorView.inputHandler.of((view, from, to, text) => {
        // Typing while the caret sits on an image-only line must not edit the
        // image Markdown: redirect the input into a new paragraph after it.
        if (from !== to || !text) return false;
        const doc = view.state.doc;
        const lineNo = doc.lineAt(from).number;
        const line = doc.line(lineNo);
        if (line.text === '' && ((lineNo > 1 && IMAGE_LINE_RE.test(doc.line(lineNo - 1).text)) || (lineNo < doc.lines && IMAGE_LINE_RE.test(doc.line(lineNo + 1).text)))) {
            // Typing on a blank line adjacent to an image block must keep a
            // blank line between them, else Markdown merges the paragraphs.
            const prevImage = lineNo > 1 && IMAGE_LINE_RE.test(doc.line(lineNo - 1).text);
            const insert = prevImage ? '\n' + text : text + '\n';
            view.dispatch({
                changes: { from: line.from, insert },
                selection: { anchor: line.from + insert.length },
                userEvent: 'input',
            });
            return true;
        }
        if (!IMAGE_LINE_RE.test(line.text)) return false;
        let toLine = lineNo;
        while (toLine < doc.lines && IMAGE_LINE_RE.test(doc.line(toLine + 1).text)) toLine++;
        const next = toLine < doc.lines ? doc.line(toLine + 1) : null;
        const at = next && next.text === '' ? next.to : doc.line(toLine).to;
        const prefix = next && next.text === '' ? '\n' : '\n\n';
        view.dispatch({
            changes: { from: at, insert: prefix + text },
            selection: { anchor: at + prefix.length + text.length },
            userEvent: 'input',
        });
        return true;
    }), ViewPlugin.fromClass(class {
        timer = 0;
        parseTimer = 0;
        observer: MutationObserver;
        unsubscribe: () => void;
        onScrollDOMMouseDown: (event: MouseEvent) => void;
        constructor(readonly view: EditorView) {
            const refreshView = () => {
                window.clearTimeout(this.timer);
                this.timer = window.setTimeout(() => view.dispatch({ effects: refresh.of(true) }), 0);
            };
            this.observer = new MutationObserver(refreshView);
            this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
            this.unsubscribe = useSession.subscribe((state, previous) => {
                if (state.settings.preview !== previous.settings.preview || state.settings.appearance !== previous.settings.appearance) refreshView();
            });
            this.onScrollDOMMouseDown = (event) => {
                const target = event.target as HTMLElement;
                if (target.closest('.cm-live-block') || target.closest('.cm-content')) return;
                const content = view.contentDOM.getBoundingClientRect();
                if (event.clientY <= content.bottom || event.clientX < content.left || event.clientX > content.right) return;
                const last = view.state.doc.line(view.state.doc.lines);
                if (!IMAGE_LINE_RE.test(last.text)) return;
                // Blank space under a trailing image: start a new paragraph after
                // it instead of putting the cursor inside the image block.
                event.preventDefault();
                event.stopPropagation();
                const at = last.to;
                view.dispatch({
                    changes: { from: at, insert: '\n\n' },
                    selection: { anchor: at + 2 },
                    userEvent: 'input',
                });
                view.focus();
            };
            view.scrollDOM.addEventListener('mousedown', this.onScrollDOMMouseDown);
            queueMicrotask(() => { const value = view.state.field(field, false); if (value) onHeadings(value.headings); });
        }
        update(update: { docChanged: boolean; selectionSet: boolean; state: EditorState; startState: EditorState }) {
            if (update.docChanged) {
                clearTimeout(this.parseTimer);
                this.parseTimer = window.setTimeout(() => this.view.dispatch({ effects: refresh.of(false) }), 90);
            }
            if (update.selectionSet && update.state.selection.main.empty) {
                // Keep the caret out of image-only lines: hop over the whole
                // image block so typing never lands inside image Markdown.
                const doc = update.state.doc;
                const head = update.state.selection.main.head;
                const lineNo = doc.lineAt(head).number;
                if (IMAGE_LINE_RE.test(doc.line(lineNo).text)) {
                    let from = lineNo;
                    let to = lineNo;
                    while (from > 1 && IMAGE_LINE_RE.test(doc.line(from - 1).text)) from--;
                    while (to < doc.lines && IMAGE_LINE_RE.test(doc.line(to + 1).text)) to++;
                    const forward = head >= update.startState.selection.main.head;
                    const anchor = forward
                        ? (to < doc.lines ? doc.line(to + 1).from : doc.length)
                        : (from > 1 ? doc.line(from - 1).to : 0);
                    window.setTimeout(() => {
                        const cur = this.view.state.selection.main;
                        if (cur.empty && this.view.state.doc.lineAt(cur.head).number === lineNo) {
                            this.view.dispatch({ selection: { anchor } });
                        }
                    }, 0);
                }
            }
            const headings = update.state.field(field).headings;
            queueMicrotask(() => { if (this.view.state.field(field, false)) onHeadings(headings); });
        }
        destroy() { clearTimeout(this.timer); clearTimeout(this.parseTimer); this.observer.disconnect(); this.unsubscribe(); this.view.scrollDOM.removeEventListener('mousedown', this.onScrollDOMMouseDown); }
    }), EditorView.domEventHandlers({
        focus(_event, view) { view.dispatch({ effects: focusChanged.of(true) }); },
        blur(_event, view) { view.dispatch({ effects: focusChanged.of(false) }); },
    }), EditorView.baseTheme({
        '.cm-live-strong': { fontWeight: '700' },
        '.cm-live-em': { fontStyle: 'italic' },
        '.cm-live-heading': { fontSize: '1.35em', fontWeight: '650' },
    }), ViewPlugin.fromClass(class {
        decorations: DecorationSet = Decoration.none;
        constructor(view: EditorView) { this.build(view); }
        update(update: { view: EditorView }) { this.build(update.view); }
        build(view: EditorView) {
            const ranges: Range<Decoration>[] = [];
            for (const { from, to } of view.visibleRanges) syntaxTree(view.state).iterate({ from, to, enter(node) {
                const cls = node.name === 'StrongEmphasis' ? 'cm-live-strong' : node.name === 'Emphasis' ? 'cm-live-em' : /^ATXHeading/.test(node.name) ? 'cm-live-heading' : '';
                if (cls) ranges.push(Decoration.mark({ class: cls }).range(node.from, node.to));
            } });
            this.decorations = Decoration.set(ranges, true);
        }
    }, { decorations: (plugin) => plugin.decorations })];
}
