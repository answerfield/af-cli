// TipTap HTML from Aspect texts → content blocks as AF writes them (paragraph, list, formula, image).
// Presentation (colors, font sizes, indents) is dropped on purpose; only the meaning is kept.

import { parseDocument } from 'htmlparser2';
import { isTag, isText, type ChildNode, type Element } from 'domhandler';
import { str, verbatim } from './text.js';

/** Inline content of a paragraph. */
export type Inline =
    | { kind: 'text'; text: string }
    | { kind: 'mark'; mark: 'strong' | 'emph' | 'mark' | 'sup' | 'sub'; children: Inline[] }
    | { kind: 'anchor'; id: string; children: Inline[] }
    | { kind: 'math'; tex: string }
    | { kind: 'image'; src: string; alt: string };

/** Block content: paragraph, list or quote. */
export type Block =
    | { kind: 'p'; inlines: Inline[] }
    | { kind: 'list'; ordered: boolean; items: Inline[][] }
    | { kind: 'quote'; blocks: Block[] };

const MARKS: Record<string, 'strong' | 'emph' | 'mark' | 'sup' | 'sub'> = {
    strong: 'strong', b: 'strong', em: 'emph', i: 'emph', u: 'mark', mark: 'mark', sup: 'sup', sub: 'sub'
};

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr']);

function nodes(html: string): ChildNode[] {
    return parseDocument(html).children;
}

/** Whether the node contains blocks (paragraphs, lists …); if so it is only a wrapper, e.g. a div around paragraphs. */
function hasBlocks(n: ChildNode): boolean {
    return isTag(n) && (BLOCKS.has(n.name) || n.children.some(hasBlocks));
}

/** Plain text; formulas without their LaTeX, block ends and line breaks as spaces. */
function textOf(list: ChildNode[]): string {
    return list.map(n => isText(n) ? n.data
        : !isTag(n) || n.name === 'annotation' ? ''
        : n.name === 'br' ? ' '
        : textOf(n.children) + (BLOCKS.has(n.name) ? ' ' : '')).join('');
}

/** HTML as plain text (e.g. for labels and instructions to human coders). */
export function plain(html: string): string {
    return textOf(nodes(html)).replace(/\s+/g, ' ').trim();
}

/** LaTeX of a formula from <annotation encoding="application/x-tex">. */
function tex(el: Element): string {
    for (const n of el.children) {
        if (!isTag(n)) continue;
        if (n.name === 'annotation') return n.children.filter(isText).map(t => t.data).join('').trim();
        const inner = tex(n);
        if (inner !== '') return inner;
    }
    return '';
}

function inlines(list: ChildNode[]): Inline[] {
    return list.flatMap((n): Inline[] => {
        if (isText(n)) return [{ kind: 'text', text: n.data }];
        if (!isTag(n)) return [];
        if (n.name === 'br') return [{ kind: 'text', text: ' ' }];
        if (n.name === 'img') return [{ kind: 'image', src: n.attribs.src ?? '', alt: n.attribs.alt ?? '' }];
        if (n.name === 'aspect-nodeview-math-formula' || n.name === 'math') return [{ kind: 'math', tex: tex(n) }];
        const mark = MARKS[n.name];
        // Anchor: text passage the unit highlights for a question
        if (n.name === 'aspect-anchor' && n.attribs['data-anchor-id']) return [{ kind: 'anchor', id: n.attribs['data-anchor-id'], children: inlines(n.children) }];
        // span, tooltip …: only the content matters
        return mark ? [{ kind: 'mark', mark, children: inlines(n.children) }] : inlines(n.children);
    });
}

function blocks(list: ChildNode[]): Block[] {
    const out: Block[] = [];
    let loose: ChildNode[] = [];   // content outside a paragraph (occurs in cells and gaps)
    const flush = () => {
        if (loose.length > 0) out.push({ kind: 'p', inlines: inlines(loose) });
        loose = [];
    };
    for (const n of list) {
        if (!isTag(n) || !hasBlocks(n)) { loose.push(n); continue; }
        flush();
        if (n.name === 'p') out.push({ kind: 'p', inlines: inlines(n.children) });
        else if (/^h\d$/.test(n.name)) out.push({ kind: 'p', inlines: [{ kind: 'mark', mark: 'strong', children: inlines(n.children) }] });
        else if (n.name === 'ul' || n.name === 'ol') {
            const items = n.children.filter((c): c is Element => isTag(c) && c.name === 'li');
            out.push({ kind: 'list', ordered: n.name === 'ol', items: items.map(li => inlines(li.children)) });
        } else if (n.name === 'blockquote') out.push({ kind: 'quote', blocks: blocks(n.children) });
        else if (n.name !== 'hr') out.push(...blocks(n.children));
    }
    flush();
    return out;
}

/** Splits an Aspect text into blocks, dropping empty paragraphs. */
export function parseHtml(html: string): Block[] {
    return blocks(nodes(html)).filter(b => b.kind !== 'p' || hasContent(b.inlines));
}

/** Whether the inlines contain anything visible (not just whitespace). */
export function hasContent(inlines: Inline[]): boolean {
    return inlines.some(n => n.kind === 'math' || n.kind === 'image' ||
        (n.kind === 'text' && n.text.replace(/[\s ]/g, '') !== '') || ((n.kind === 'mark' || n.kind === 'anchor') && hasContent(n.children)));
}

/** Stores media embedded in texts (images as data: URLs) and returns the path that replaces them. */
export type MediaSink = (dataUrl: string, hint: string) => string;

/** Anchor ID → condition under which the passage is highlighted (see flow.ts). */
export type Anchors = (id: string) => string | undefined;

/** Inlines as AF content: the separate parts as they appear one after another in `p { … }`. */
export function renderInlines(inlines: Inline[], media: MediaSink, anchors: Anchors = () => undefined): string[] {
    const parts: string[] = [];
    let text = '';
    const flush = () => {
        if (text !== '') parts.push(str(text));
        text = '';
    };
    for (const n of inlines) {
        if (n.kind === 'text') { text += n.text; continue; }
        flush();
        if (n.kind === 'math') parts.push(`math(${verbatim(n.tex)})`);
        else if (n.kind === 'image') parts.push(`image(${str(n.src.startsWith('data:') ? media(n.src, 'bild') : n.src)}, ${str(n.alt)})`);
        else if (n.kind === 'anchor') {
            const inner = renderInlines(n.children, media, anchors).join(' + ');
            const when = anchors(n.id);
            if (inner === '') continue;
            parts.push(when === undefined || when === 'false' ? inner
                : when === 'true' ? `mark(${inner})` : `if ${when} then mark(${inner}) else ${inner}`);
        } else {
            const inner = renderInlines(n.children, media, anchors);
            if (inner.length > 0) parts.push(`${n.mark}(${inner.join(' + ')})`);
        }
    }
    flush();
    // Trim whitespace at the start and end of a paragraph
    if (parts.length > 0 && parts[0].startsWith('"')) parts[0] = `"${parts[0].slice(1).replace(/^[\s ]+/, '')}`;
    const last = parts.length - 1;
    if (last >= 0 && parts[last].endsWith('"')) parts[last] = `${parts[last].slice(0, -1).replace(/[\s ]+$/, '')}"`;
    return parts.filter(p => p !== '""');
}

/** Blocks as AF statements. */
export function renderBlocks(blocks: Block[], media: MediaSink, indent: string, anchors: Anchors = () => undefined): string[] {
    const lines: string[] = [];
    for (const b of blocks) {
        if (b.kind === 'p') {
            const parts = renderInlines(b.inlines, media, anchors);
            if (parts.length === 1 && parts[0].startsWith('"')) lines.push(`${indent}p ${parts[0]}`);
            else if (parts.length > 0) lines.push(`${indent}p { ${parts.join(' ')} }`);
        } else if (b.kind === 'list') {
            lines.push(`${indent}list${b.ordered ? '(ordered: true)' : ''} {`);
            for (const item of b.items) {
                const parts = renderInlines(item, media, anchors);
                if (parts.length > 0) lines.push(`${indent}  p { ${parts.join(' ')} }`);
            }
            lines.push(`${indent}}`);
        } else {
            lines.push(`${indent}box {`, ...renderBlocks(b.blocks, media, `${indent}  `, anchors), `${indent}}`);
        }
    }
    return lines;
}
