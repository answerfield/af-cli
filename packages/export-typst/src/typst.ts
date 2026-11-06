// Item or booklet → Typst source for a print version. Input is the evaluated node tree from runtime-core (state,
// loops, variants and needs profile apply as in the digital runtime). Paper rules exist only for the built-in
// elements; std components inherit them.

import { Arc, Dimension, Interval, Point, Rational, display, isContentValue, polar, type Value } from '@answerfield/expr';
import type { RElement, RNode } from '@answerfield/runtime-core';
import { texToTypst } from './math.js';

/** An item in the print version: heading and evaluated nodes. */
export interface PrintItem {
    title: string;
    nodes: RNode[];
    /** Instruction page (no numbered item heading). */
    instruction?: boolean;
}

/** A booklet part (or the single implicit part of a lone item). */
export interface PrintPart {
    title?: string;
    items: PrintItem[];
}

/** Typst source plus everything needed to render it. */
export interface TypstOutput {
    source: string;
    /** Media used (bundle paths). */
    assets: string[];
    /** Additional files for typesetting (brand logo), path → content. */
    files?: Record<string, Uint8Array>;
    /** Notes on what is only approximated on paper. */
    notes: string[];
}

interface Ctx {
    /** Inside running text (paragraph): atoms rendered inline. */
    inline: boolean;
    /** Inside a group of options: toggles rendered as a row with a checkbox. */
    options: boolean;
}

interface Frame { x0: number; x1: number; y0: number; y1: number; s: number }

/** Escapes text for Typst markup. */
export function esc(text: string): string {
    return text.replace(/[\\#$*_`<>@[\]~"'=+\-/]/g, c => `\\${c}`).replace(/\r?\n/g, ' ');
}

/** String literal in Typst code. */
const str = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const num = (n: number) => `${Math.round(n * 1000) / 1000}`;

/** Item size value (`6em`, `3ch`) as a Typst length. */
function length(v: Value, fallback: string): string {
    if (!(v instanceof Dimension)) return fallback;
    const m = /^([\d.]+)\s*(em|ch|px|cm|mm|pt|%|rem)$/.exec(v.text);
    if (!m) return fallback;
    const n = Number(m[1]);
    switch (m[2]) {
        case 'ch': return `${num(n * 0.55)}em`;
        case 'rem': return `${n}em`;
        case 'px': return `${num(n * 0.75)}pt`;
        default: return `${n}${m[2]}`;
    }
}

/** Size value in cm (for planes); 1em ≈ 12pt. */
function centimeters(v: Value): number | undefined {
    if (!(v instanceof Dimension)) return undefined;
    const m = /^([\d.]+)\s*(em|rem|cm|mm|pt|px)$/.exec(v.text);
    if (!m) return undefined;
    const n = Number(m[1]);
    return { em: n * 0.423, rem: n * 0.423, cm: n, mm: n / 10, pt: n * 0.0353, px: n * 0.0265 }[m[2]];
}

const MARKS: Record<string, (body: string) => string> = {
    mark: b => `#highlight(fill: luma(225))[${b}]`, emph: b => `#emph[${b}]`, strong: b => `#strong[${b}]`,
    title: b => `#emph[${b}]`, del: b => `#strike[${b}]`, sup: b => `#super[${b}]`, sub: b => `#sub[${b}]`
};

/** Renders evaluated nodes to Typst markup, collecting used media and notes. */
export class TypstWriter {
    readonly assets = new Set<string>();
    readonly notes = new Set<string>();

    /** Content (text, markup, image, formula) as Typst markup. */
    inline(value: Value): string {
        if (isContentValue(value)) {
            const a = value.args;
            if (MARKS[value.content]) return MARKS[value.content](this.inline(a.text ?? null));
            if (value.content === 'seq') return Array.isArray(a.items) ? (a.items as Value[]).map(v => this.inline(v)).join('') : '';
            if (value.content === 'image') {
                const src = display(a.src ?? null);
                this.assets.add(src);
                const width = a.width instanceof Dimension ? `, width: ${length(a.width, '100%')}` : ', width: 100%';
                return `#box(image(${str('/assets/' + src)}, alt: ${str(display(a.alt ?? null))}${width}))`;
            }
            if (value.content === 'math') {
                const tex = display(a.tex ?? null);
                const typst = texToTypst(tex);
                if (typst !== undefined) return `$${typst}$`;
                this.notes.add(`Formel nicht umgesetzt (als Text gesetzt): ${tex}`);
                return `#raw(${str(tex)})`;
            }
            return '';
        }
        return esc(display(value));
    }

    /** Node sequence; blocks separated by blank lines, inline content concatenated. */
    nodes(nodes: RNode[], ctx: Ctx): string {
        return nodes.map(n => this.node(n, ctx)).join(ctx.inline ? '' : '\n\n');
    }

    node(node: RNode, ctx: Ctx): string {
        switch (node.kind) {
            case 'content': {
                try { return this.inline(node.value.peek()); } catch { return ''; }
            }
            case 'component': return this.nodes(node.children, ctx);
            case 'for': return node.iterations.peek().map(it => this.nodes(it, ctx)).join(ctx.inline ? '' : '\n\n');
            case 'show': {
                const body = this.nodes(node.children, ctx);
                let visible = false;
                try { visible = node.visible.peek(); } catch { /* verborgen */ }
                if (visible || ctx.inline || body.trim() === '') return body;
                this.notes.add('Bedingte Abschnitte gedruckt (digital erst unter einer Bedingung sichtbar)');
                return `#block(inset: (left: 6pt), stroke: (left: (paint: luma(150), thickness: 1pt, dash: "dashed")))[${body}]`;
            }
            case 'error': return '';
            case 'element': return this.element(node, ctx);
        }
    }

    private element(el: RElement, ctx: Ctx): string {
        const props = el.props.peek();
        const a = props.args;
        const children = (c: Partial<Ctx> = {}) => this.nodes(el.children, { ...ctx, ...c });
        const described = (out: string) => {
            const extended = props.variants.extended_descriptions;
            return extended === undefined ? out : `${out}\n\n#text(size: 0.85em)[${this.inline(extended)}]`;
        };
        switch (el.element) {
            case 'page': return children({ inline: false, options: false });
            case 'section': {
                const heading = a.heading !== null && a.heading !== undefined ? `#strong[${this.inline(a.heading)}]\n\n` : '';
                return heading + children({ inline: false });
            }
            case 'p': {
                // Paragraph of paragraphs (e.g. easy language: one sentence per line): render the inner ones on their own
                if (el.children.some(c => c.kind === 'element' && c.element === 'p')) return children({ inline: false, options: false });
                const body = children({ inline: true, options: false });
                if (body.trim() === '') return '';
                return a.tone === 'hint' ? `#text(size: 0.9em, style: "italic")[${body}]` : `#par[${body}]`;
            }
            case 'box': {
                const heading = a.heading !== null && a.heading !== undefined ? `#strong[${this.inline(a.heading)}] \\\n` : '';
                return `#block(width: 100%, inset: 8pt, radius: 4pt, stroke: 0.6pt)[${heading}${children({ inline: false })}]`;
            }
            case 'stimulus': return described(`#block(width: 100%, inset: (left: 10pt, y: 2pt), stroke: (left: 1.5pt + luma(150)))[${children({ inline: false })}]`);
            case 'list': {
                const items = this.leaves(el.children).map(n => `[${this.node(n, { inline: false, options: false })}]`);
                return `#${a.ordered === true ? 'enum' : 'list'}(${items.join(', ')})`;
            }
            case 'lines': {
                const every = a.every instanceof Rational ? a.every.toNumber() : 5, start = a.start instanceof Rational ? a.start.toNumber() : 1;
                const cells = this.leaves(el.children).flatMap((n, i) => {
                    const no = start + i;
                    return [`[${no % every === 0 || i === 0 ? `#text(size: 0.8em, fill: luma(100))[${no}]` : ''}]`, `[${this.node(n, { inline: true, options: false })}]`];
                });
                return `#grid(columns: (2em, 1fr), row-gutter: 0.6em, ${cells.join(', ')})`;
            }
            case 'row': {
                const cols = this.leaves(el.children).map(n => this.node(n, { inline: false, options: ctx.options })).filter(c => c.trim() !== '');
                if (cols.length <= 1) return cols.join('');
                return `#grid(columns: (${cols.map(() => '1fr').join(', ')}), column-gutter: 1.2em, ${cols.map(c => `[${c}]`).join(', ')})`;
            }
            case 'table': return described(this.table(el));
            case 'group': return this.group(el, ctx);
            case 'toggle': return this.toggle(el, ctx);
            case 'input': return this.input(el, ctx);
            case 'value': return this.value(el);
            case 'plane': return described(this.plane(el));
            case 'media': {
                const video = /\.(mp4|m4v|webm|ogv|mov)(\?|#|$)/i.test(String(a.src ?? ''));
                this.notes.add(video ? 'Videos: die Lehrkraft zeigt sie' : 'Hörtexte: die Lehrkraft spielt sie ab');
                const label = a.label !== null && a.label !== undefined ? `: ${this.inline(a.label)}` : '';
                return `#block(width: 100%, inset: 8pt, radius: 4pt, fill: luma(235))[*${video ? 'Video' : 'Hörtext'}*${label} – ${video ? 'die Lehrkraft zeigt es' : 'die Lehrkraft spielt ihn ab'}.]`;
            }
            // Timers and flow steer the screen only; the paper version has no clock
            case 'timer': case 'flow':
                return '';
            case 'cell': case 'dot': case 'caption': case 'polygon':
                return children();
            default:
                this.notes.add(`Baustein ohne Papierform: ${el.element}`);
                return children();
        }
    }

    /**
     * Blocks of an item kept together: each block sticks to the next (`sticky`) so an item does not break between
     * question and figure. If it does not fit on one page, Typst breaks it anyway.
     */
    task(nodes: RNode[], title?: string): string {
        // Top level: look through pages, sections, components and loops; conditionals stay (printed with a note);
        // section headings become separate blocks
        const chunks = (list: RNode[]): string[] => list.flatMap(n => {
            if (n.kind === 'component') return chunks(n.children);
            if (n.kind === 'for') return n.iterations.peek().flatMap(chunks);
            if (n.kind === 'element' && n.element === 'page') return chunks(n.children);
            if (n.kind === 'element' && n.element === 'section') {
                const heading = n.props.peek().args.heading;
                return [...(heading !== null && heading !== undefined ? [`#strong[${this.inline(heading)}]`] : []), ...chunks(n.children)];
            }
            return [this.node(n, { inline: false, options: false })];
        });
        const blocks = chunks(nodes).filter(b => b.trim() !== '');
        // sticky only works between sibling blocks, so heading and blocks are siblings, not nested
        if (title !== undefined) blocks.unshift(`#text(weight: "bold", size: 1.1em)[${title}]`);
        return blocks.map((b, i) => i < blocks.length - 1 ? `#block(sticky: true, width: 100%, below: 0.9em)[${b}]`
            : `#block(width: 100%, below: 2em)[${b}]`).join('\n');
    }

    /** Elements and content, looking through wrappers (component, loop, conditional). */
    private leaves(nodes: RNode[]): RNode[] {
        return nodes.flatMap(n => {
            if (n.kind === 'component') return this.leaves(n.children);
            if (n.kind === 'for') return n.iterations.peek().flatMap(it => this.leaves(it));
            if (n.kind === 'show') {
                let visible = false;
                try { visible = n.visible.peek(); } catch { /* verborgen */ }
                return visible ? this.leaves(n.children) : [];
            }
            if (n.kind === 'content') {
                try { return display(n.value.peek()).trim() === '' && !isContentValue(n.value.peek()) ? [] : [n]; } catch { return []; }
            }
            return [n];
        });
    }

    /** Elements with the given name among the leaves, also inside groups (matrix rows). */
    private find(nodes: RNode[], name: string): RElement[] {
        return this.leaves(nodes).flatMap(n => n.kind !== 'element' ? []
            : n.element === name ? [n] : n.element === 'group' ? this.find(n.children, name) : []);
    }

    private table(el: RElement): string {
        const a = el.props.peek().args;
        const rows = this.leaves(el.children).filter((n): n is RElement => n.kind === 'element' && n.element === 'row');
        const cellsOf = (row: RElement) => this.find(row.children, 'cell');
        const span = (c: RElement) => { const s = c.props.peek().args.span; return s instanceof Rational ? s.toNumber() : 1; };
        const columns = Math.max(1, ...rows.map(r => cellsOf(r).reduce((n, c) => n + span(c), 0)));
        const cell = (c: RElement) => {
            const body = this.nodes(c.children, { inline: false, options: false });
            return span(c) > 1 ? `table.cell(colspan: ${span(c)})[${body}]` : `[${body}]`;
        };
        const parts = rows.map(r => r.props.peek().args.head === true
            ? `table.header(${cellsOf(r).map(c => cell(c).replace(/^\[/, '[#strong[').replace(/\]$/, ']]')).join(', ')})`
            : cellsOf(r).map(cell).join(', '));
        const caption = a.caption !== null && a.caption !== undefined ? `#strong[${this.inline(a.caption)}]\n\n` : '';
        return `${caption}#table(columns: ${columns}, inset: 6pt, stroke: 0.5pt, align: horizon, ${parts.filter(Boolean).join(', ')})`;
    }

    private group(el: RElement, ctx: Ctx): string {
        const a = el.props.peek().args;
        const label = a.label !== null && a.label !== undefined ? this.inline(a.label) : '';
        if (a.dropdown === true) {
            // Select list: options side by side to tick
            const options = this.find(el.children, 'toggle').map(t => `#af-box ${this.nodes(t.children, { inline: true, options: false })}`);
            const line = options.join(' #h(1.2em) ');
            return ctx.inline ? `${line}` : `${label ? `${label}\n\n` : ''}${line}`;
        }
        const body = this.nodes(el.children, { inline: ctx.inline, options: true });
        if (ctx.inline) return body;
        // Keep the question with its options (no page break in between)
        return label ? `#block(above: 1.4em, below: 0.6em, sticky: true)[${label}]\n${body}` : body;
    }

    private toggle(el: RElement, ctx: Ctx): string {
        const a = el.props.peek().args;
        const content = this.nodes(el.children, { inline: true, options: false });
        // Buttons (start a play, show the tasks) have no function on paper
        if (a.role === 'button') return '';
        const look = typeof a.look === 'string' ? a.look : 'box';
        // Inline: words as printed (highlighting is done by hand); a gap for a single character
        if (look === 'slot') return '#h(0.9em)';
        if (look !== 'box') return content;
        if (content.trim() === '') return '#af-box';
        return ctx.options && !ctx.inline ? `#af-option[${content}]` : `#af-box ${content}`;
    }

    private input(el: RElement, ctx: Ctx): string {
        const a = el.props.peek().args;
        if (a.multiline === true) {
            const max = a.max instanceof Rational ? a.max.toNumber() : 300;
            const lines = Math.min(12, Math.max(3, Math.ceil(max / 70)));
            const label = a.label !== null && a.label !== undefined ? `${this.inline(a.label)}\n\n` : '';
            return `${label}#af-lines(${max >= 1000 ? 6 : lines})`;
        }
        const gap = `#af-gap(${length(a.width, '6em')})`;
        return ctx.inline ? gap : `#block(${gap.slice(1)})`;
    }

    /** Slider outside a plane: a scale to mark by hand. */
    private value(el: RElement): string {
        const a = el.props.peek().args;
        if (!(a.min instanceof Rational) || !(a.max instanceof Rational) || !(a.step instanceof Rational)) return '';
        const min = a.min.toNumber(), max = a.max.toNumber(), step = a.step.toNumber();
        const n = Math.round((max - min) / step);
        if (n <= 0 || n > 200) return '';
        const label = a.label !== null && a.label !== undefined ? `${this.inline(a.label)}\n\n` : '';
        const every = Math.ceil(n / 10);
        const ticks = Array.from({ length: n + 1 }, (_, k) => {
            const x = `${num((k / n) * 100)}%`;
            const text = k % every === 0 ? `#place(dx: ${x}, dy: 10pt, box(width: 0pt, align(center, text(size: 8pt)[${esc(display(Rational.of(0).add(a.min as Rational).add((a.step as Rational).mul(Rational.of(k)))))}])))` : '';
            return `#place(dx: ${x}, line(start: (0pt, -4pt), end: (0pt, 4pt), stroke: 0.6pt))${text}`;
        });
        return `${label}#block(width: 90%, height: 26pt, inset: (top: 6pt))[#line(length: 100%, stroke: 0.8pt)${ticks.join('')}]`;
    }

    private plane(el: RElement): string {
        const a = el.props.peek().args;
        if (!(a.x instanceof Interval)) return '';
        const x0 = a.x.from.toNumber(), x1 = a.x.to.toNumber();
        let y0: number, y1: number;
        if (a.y instanceof Interval) { y0 = a.y.from.toNumber(); y1 = a.y.to.toNumber(); }
        else { const h = (x1 - x0) / 20; y0 = -h; y1 = h; }
        // Width: as given, else wide enough to draw one unit comfortably (at most the text width)
        const widthCm = Math.min(16, centimeters(a.width) ?? 14);
        const f: Frame = { x0, x1, y0, y1, s: widthCm / (x1 - x0) };
        const X = (x: number) => `${num((x - x0) * f.s)}cm`, Y = (y: number) => `${num((y1 - y) * f.s)}cm`;
        const parts: string[] = [];
        const background = typeof a.background === 'string' ? a.background : undefined;
        if (background) {
            this.assets.add(background);
            parts.push(`#place(image(${str('/assets/' + background)}, width: 100%, height: 100%, fit: "stretch"))`);
        }
        const grid = a.grid instanceof Rational ? a.grid.toNumber() : undefined;
        if (grid && (x1 - x0) / grid <= 80 && (y1 - y0) / grid <= 80) {
            for (let x = Math.ceil(x0 / grid) * grid; x <= x1 + 1e-9; x += grid) parts.push(`#place(line(start: (${X(x)}, 0cm), end: (${X(x)}, ${Y(y0)}), stroke: 0.4pt + luma(200)))`);
            for (let y = Math.ceil(y0 / grid) * grid; y <= y1 + 1e-9; y += grid) parts.push(`#place(line(start: (0cm, ${Y(y)}), end: (${X(x1)}, ${Y(y)}), stroke: 0.4pt + luma(200)))`);
        }
        // Arcs become points every few degrees (Typst polygons have straight sides; at print size this looks round)
        const points = (v: Value) => (Array.isArray(v) ? v as Value[] : []).filter((p): p is Point => p instanceof Point).flatMap(p => {
            if (!(p instanceof Arc)) return [p];
            const from = p.from.toNumber(), to = p.to.toNumber(), steps = Math.max(2, Math.ceil(Math.abs(to - from) / 6));
            return Array.from({ length: steps + 1 }, (_, i) => polar(p.center, p.radius, Rational.parse(String(from + (to - from) * i / steps)) ?? Rational.of(0)));
        });
        const at = (p: Point) => [p.x.toNumber(), p.y.toNumber()] as const;
        const notes: string[] = [];
        // Shapes and atoms of the plane, also inside groups (e.g. toggles sharing a name)
        // A toggle with shapes prints its shapes, empty, to color in by hand
        const inPlane = (nodes: RNode[]): RElement[] => this.leaves(nodes).flatMap(n =>
            n.kind !== 'element' ? [] : n.element === 'group' || (n.element === 'toggle' && n.children.length > 0) ? inPlane(n.children) : [n]);
        // Axes from the plane's x_axis/y_axis (even ""), with a numbered grid; the name sits at the axis end
        for (const horizontal of [true, false]) {
            const name = horizontal ? a.x_axis : a.y_axis;
            if (name === null || name === undefined) continue;
            const zero = horizontal ? Math.min(Math.max(0, y0), y1) : Math.min(Math.max(0, x0), x1);
            parts.push(horizontal
                ? `#place(line(start: (0cm, ${Y(zero)}), end: (${X(x1)}, ${Y(zero)}), stroke: 0.9pt))`
                : `#place(line(start: (${X(zero)}, 0cm), end: (${X(zero)}, ${Y(y0)}), stroke: 0.9pt))`);
            const label = this.inline(name);
            if (label) parts.push(horizontal
                ? `#place(dx: ${X(x1)} - 1cm, dy: ${Y(zero)} - 14pt, box(width: 1cm, align(right, emph[${label}])))`
                : `#place(dx: ${X(zero)} + 4pt, dy: 0cm, emph[${label}])`);
            if (grid) {
                const [from, to] = horizontal ? [x0, x1] : [y0, y1];
                const every = Math.ceil((to - from) / grid / 20) * grid;
                for (let v = Math.ceil(from / every) * every; v <= to + 1e-9; v += every) {
                    if (Math.abs(v) < 1e-9 && !horizontal) continue;
                    const text = `text(size: 7pt)[${esc(display(Rational.parse(String(Math.round(v * 1000) / 1000)) ?? Rational.of(0)))}]`;
                    parts.push(horizontal
                        ? `#place(dx: ${X(v)} - 1cm, dy: ${Y(zero)} + 2pt, box(width: 2cm, align(center, ${text})))`
                        : `#place(dx: ${X(zero)} - 1.05cm, dy: ${Y(v)} - 4pt, box(width: 1cm, align(right, ${text})))`);
                }
            }
        }
        for (const n of inPlane(el.children)) {
            const p = n.props.peek().args;
            switch (n.element) {
                case 'polygon': {
                    const ps = points(p.points);
                    if (ps.length < 2) break;
                    const given = Array.isArray(p.points) ? p.points as Value[] : [];
                    const closed = p.closed !== false && ps.length >= 3 && given.every(q => q instanceof Point);
                    const coords = ps.map(q => `(${X(at(q)[0])}, ${Y(at(q)[1])})`).join(', ');
                    parts.push(closed
                        ? `#place(polygon(fill: ${p.tone === 'accent' ? 'luma(200)' : p.tone === 'neutral' ? 'none' : 'luma(240)'}, stroke: 0.9pt, ${coords}))`
                        : ps.slice(1).map((q, i) => `#place(line(start: (${X(at(ps[i])[0])}, ${Y(at(ps[i])[1])}), end: (${X(at(q)[0])}, ${Y(at(q)[1])}), stroke: 0.9pt))`).join(''));
                    break;
                }
                case 'dot': {
                    if (!(p.at instanceof Point)) break;
                    const [x, y] = at(p.at);
                    const label = p.label !== null && p.label !== undefined ? this.inline(p.label) : '';
                    if (p.shape === 'notch') {
                        parts.push(`#place(line(start: (${X(x)}, ${Y(y)} - 4pt), end: (${X(x)}, ${Y(y)} + 4pt), stroke: 0.9pt))`);
                        if (label) parts.push(`#place(dx: ${X(x)} - 1cm, dy: ${Y(y)} + 5pt, box(width: 2cm, align(center, text(size: 8pt)[${label}])))`);
                    } else {
                        parts.push(`#place(dx: ${X(x)} - 2pt, dy: ${Y(y)} - 2pt, circle(radius: 2pt, fill: black))`);
                        if (label) parts.push(`#place(dx: ${X(x)} + 3pt, dy: ${Y(y)} - 12pt, text(size: 9pt)[${label}])`);
                    }
                    break;
                }
                case 'caption': {
                    if (!(p.at instanceof Point)) break;
                    const [x, y] = at(p.at);
                    parts.push(`#place(dx: ${X(x)} - 2cm, dy: ${Y(y)} - 5pt, box(width: 4cm, align(center, text(size: 9pt)[${this.inline(p.text ?? null)}])))`);
                    break;
                }
                case 'toggle': case 'input': {
                    if (!(p.at instanceof Point)) break;
                    const [x, y] = at(p.at);
                    const mark = n.element === 'toggle' ? 'af-box' : `af-gap(${length(p.width, '3em')})`;
                    parts.push(`#place(dx: ${X(x)} - 0.5em, dy: ${Y(y)} - 0.5em, box[#${mark}])`);
                    break;
                }
                case 'value': {
                    // Point to draw: printed as an instruction below the plane
                    if (p.label !== null && p.label !== undefined) notes.push(this.inline(p.label));
                    break;
                }
            }
        }
        const body = `#box(width: ${X(x1)}, height: ${Y(y0)})[${parts.join('')}]`;
        const draw = notes.length > 0 ? `\n\n#text(size: 0.9em)[Zeichne ein: ${notes.join(', ')}]` : '';
        // Keep plane and instruction together
        return `#block(breakable: false, width: 100%)[#align(center, ${body.slice(1)})${draw}]`;
    }
}

/**
 * Brand (white labeling): header with logo, footer and cover page, e.g. of a federal state. Independent of items and
 * bundle: the same bundle yields one booklet per brand.
 */
export interface Brand {
    /** E.g. "Beispielland". */
    name: string;
    /** Logo path in the typesetting file system, e.g. /brand/logo.svg (data in TypstOutput.files). */
    logo?: string;
    /** Lines right of the logo, e.g. ministry and assessment name. */
    header?: string[];
    /** Footer line, e.g. "Nur für den Einsatz an unseren Schulen". */
    footer?: string;
    /** Cover page with large logo, title, effective accommodations and fields to fill in. */
    cover?: { fields?: string[] };
}

/** Page layout settings for `preamble` and `document`. */
export interface Layout {
    title: string;
    /** Font scale factor (large print). */
    scale: number;
    brand?: Brand;
    /** Edition identifier (e.g. bundle checksum prefix), printed small in the footer. */
    edition?: string;
    /** Effective accommodations, human-readable (cover, footer). */
    adaptations: string[];
}

/** Accommodation names as printed (omitting those that change nothing on paper). */
export const ADAPTATION_NAMES: Readonly<Record<string, string>> = {
    simple_language: 'Einfache Sprache', easy_language: 'Leichte Sprache', magnification: 'Großdruck',
    extended_descriptions: 'Bildbeschreibungen', extended_time: 'Zeitverlängerung'
};

/** Template: page, font, header and footer, and the paper building blocks (af-box, af-gap …). */
export function preamble(layout: Layout): string {
    const { title, scale, brand } = layout;
    const logo = (height: string) => brand?.logo ? `image(${str(brand.logo)}, height: ${height})` : 'none';
    const lines = (brand?.header ?? []).map(esc).join(' \\ ');
    // Header only with a brand, and not on the cover (which shows the logo large)
    const header = brand ? `,
  header: context if ${brand.cover ? 'counter(page).get().first() > 1' : 'true'} [
    #grid(columns: (auto, 1fr), column-gutter: 10pt, align: horizon, ${logo('1.2cm')}, align(right, text(size: 8.5pt)[${lines || esc(brand.name)}]))
    #v(-2pt) #line(length: 100%, stroke: 0.5pt + luma(150))
  ]` : '';
    const second = [brand?.footer ? esc(brand.footer) : '', [layout.edition ? `Fassung ${esc(layout.edition)}` : '', ...layout.adaptations.map(esc)].filter(Boolean).join(' · ')];
    const footer = `[#set text(size: 8pt, fill: luma(90)); ${esc(title)} #h(1fr) Seite #counter(page).display() von #counter(page).final().first()${second.some(Boolean) ? ` \\ #text(fill: luma(130))[${second[0]} #h(1fr) ${second[1]}]` : ''}]`;
    return `#set document(title: ${str(title)}, date: none)
#set page(paper: "a4", margin: (x: 2cm, top: ${brand ? '3cm' : '2cm'}, bottom: 2.4cm)${header},
  footer: context ${footer})
#set text(font: "Atkinson Hyperlegible", size: ${num(12 * scale)}pt, lang: "de", hyphenate: true)
#set par(leading: 0.7em, spacing: 1.1em, justify: false)
#show math.equation: set text(font: "New Computer Modern Math")
#let af-box = box(width: 0.85em, height: 0.85em, stroke: 0.7pt, baseline: 0.05em)
#let af-option(body) = block(spacing: 0.7em, grid(columns: (1.5em, 1fr), af-box, body))
#let af-gap(width) = box(width: width, height: 1.3em, stroke: (bottom: 0.7pt), baseline: 0.35em)
#let af-lines(n) = block(width: 100%, for i in range(n) { block(width: 100%, height: 1.8em, spacing: 0pt, stroke: (bottom: 0.5pt + luma(140))) })
#let af-stop = align(right, box(inset: (x: 10pt, y: 6pt), radius: 4pt, stroke: 1.2pt, text(weight: "bold")[STOPP]))
`;
}

/** Brand cover page: logo, brand name, title, accommodations, fields to fill in. */
function cover(layout: Layout): string {
    const brand = layout.brand!;
    const fields = (brand.cover?.fields ?? []).map(f => `[${esc(f)}:], box(width: 100%, height: 1.6em, stroke: (bottom: 0.7pt))`).join(', ');
    return `#page(header: none)[
  #align(center)[
    #v(1.5cm)
    ${brand.logo ? `#image(${str(brand.logo)}, height: 4cm)` : ''}
    #v(0.5cm)
    #text(size: 1.2em)[${esc(brand.name)}]
    #v(2.5cm)
    #text(size: 1.8em, weight: "bold")[${esc(layout.title)}]
    ${layout.adaptations.length > 0 ? `#v(0.4cm)
    #text(size: 1.1em)[${layout.adaptations.map(esc).join(' · ')}]` : ''}
  ]
  #v(1fr)
  ${fields ? `#grid(columns: (auto, 1fr), column-gutter: 8pt, row-gutter: 14pt, align: bottom, ${fields})` : ''}
  #v(1cm)
]`;
}

/** Whole document: parts start on an even (left) page and, if there are several, end with STOPP (as in printed booklets). */
export function document(layout: Layout, parts: PrintPart[], writer: TypstWriter): string {
    const out = [preamble(layout)];
    if (layout.brand?.cover) out.push(cover(layout));
    let no = 0;
    parts.forEach((part, k) => {
        if (k > 0 || layout.brand?.cover) out.push('#pagebreak(to: "even", weak: true)');
        if (part.title) out.push(`#align(center, text(size: 1.3em, weight: "bold")[${esc(part.title)}])\n#v(1em)`);
        part.items.forEach((item, i) => {
            const heading = item.instruction ? (item.title ? esc(item.title) : undefined) : `Aufgabe ${++no}${item.title ? `: ${esc(item.title)}` : ''}`;
            out.push(writer.task(item.nodes, heading));
            if (i < part.items.length - 1 && item.instruction) out.push('#pagebreak(weak: true)');
        });
        if (parts.length > 1) out.push('#af-stop');
    });
    return out.join('\n\n') + '\n';
}
