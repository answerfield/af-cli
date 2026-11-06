// Aspect unit → AF item: pages, sections, elements. The coding is converted in coding.ts.

import type { Flow } from './flow.js';
import { parseHtml, plain, renderBlocks, type MediaSink } from './html.js';
import { Names, option, shorten, str, verbatim } from './text.js';
import type { AspectElement, AspectSection, IqbUnit } from './unit.js';
import { translateGeoGebra } from './geogebra.js';

/** AF name of an IQB variable and how to map its values (for the coding and the comparison test). */
export type Answer =
    | { kind: 'text'; name: string; math?: boolean }                        // math: formula field (proportions via proportion())
    | { kind: 'choice'; name: string; options: number }                       // Choice: set of option numbers
    | { kind: 'select'; name: string; options: number; items?: string[] }     // Select: option number; items: aliases of the drag items
    | { kind: 'row'; name: string; options: number; index: number }           // matrix row
    | { kind: 'check'; name: string }                         // Check: true/false
    | { kind: 'words'; name: string; text: string }           // MarkWords: word numbers
    | { kind: 'drawing'; name: string }                       // GeoGebra: Geoboard lines or draggable points (coded by hand)
    | { kind: 'point'; name: string; expr: string };          // GeoGebra point tracked by the IQB: expr is e.g. geo[1]

/** How faithfully an element was converted: adopted, approximated or missing. */
export type Fidelity = 'kept' | 'approximated' | 'missing';

/** One entry of the import report. */
export interface ReportEntry {
    element: string;
    type: string;
    fidelity: Fidelity;
    note?: string;
}

/** Mutable state shared while converting one unit. */
export interface Context {
    unit: IqbUnit;
    names: Names;
    media: MediaSink;
    /** IQB variable ID → AF response. */
    answers: Map<string, Answer>;
    report: ReportEntry[];
    /** Elements by ID (including embedded ones), for drag and drop. */
    byId: Map<string, AspectElement>;
    /** Variables with coding rules (to tell highlighting from plain text). */
    coded: Set<string>;
    /** Last prompt text, used as the label of fields without their own. */
    prompt: string;
    /** Audio elements in use (for visibility rules). */
    audios: Set<string>;
    /** IQB variable ID → name of the AF coding rule. */
    rules: Map<string, string>;
    /** Flow control: states, buttons, highlights. */
    flow: Flow;
    /** Controls already emitted (by state ID). */
    emitted: Set<string>;
    /** Expressions known only after the full pass (placeholder → expression): visibility, locked cards. */
    deferred: Map<string, () => string>;
    /** Pool → names of its slots. */
    pools: Map<string, string[]>;
    /** AF name of the item (prefix for generated components). */
    item: string;
    /** Generated top-level declarations (components for GeoGebra applets). */
    components: string[][];
}

const INDENT = '  ';

/** Symbol bar for calculations and explanations (replaces the formula editor of the IQB player). */
const MATH_KEYS = '["·", ":", "²", "³", "√", "π", "≈", "≤", "≥", "°"]';

function note(ctx: Context, el: AspectElement, fidelity: Fidelity, text?: string): void {
    ctx.report.push({ element: el.alias, type: el.type, fidelity, ...(text ? { note: text } : {}) });
}

/** Label of a field: its own, else the preceding prompt text, else the alias. */
function labelOf(ctx: Context, el: AspectElement): string {
    const own = typeof el.label === 'string' ? plain(el.label) : '';
    if (own !== '') return own;
    if (ctx.prompt !== '') return shorten(ctx.prompt);
    return `Antwort ${el.alias}`;
}

function bind(ctx: Context, el: AspectElement, answer: (name: string) => Answer): string {
    const name = ctx.names.take(el.alias);
    ctx.answers.set(el.id, answer(name));
    return name;
}

/** One element as AF statements (usually one line; without indentation inside cloze texts). */
export function convertElement(ctx: Context, el: AspectElement, indent: string): string[] {
    switch (el.type) {
        case 'text': {
            const html = String(el.text ?? '');
            if (ctx.coded.has(el.id)) {
                // highlightable text whose highlighting is coded
                const text = plain(html);
                const name = bind(ctx, el, n => ({ kind: 'words', name: n, text }));
                note(ctx, el, 'approximated', 'Markieren im Text → MarkWords; Wortzählung und Farben prüfen');
                return [`${indent}${name} = MarkWords(${str(text)}, label: ${str(shorten(ctx.prompt || 'Markiere im Text.'))}, look: highlight)`];
            }
            if (ctx.flow.labels.has(el.id)) {
                note(ctx, el, 'kept', 'Beschriftung des Knopfs');
                return [];
            }
            const blocks = parseHtml(html);
            const text = plain(html);
            if (text !== '') ctx.prompt = text;
            note(ctx, el, 'kept');
            return renderBlocks(blocks, ctx.media, indent, id => ctx.flow.anchors.get(id));
        }
        case 'text-field':
        case 'text-field-simple':
        case 'math-field': {
            // Formula field: in VERA always a proportion (fraction, decimal, percent, ratio); coded via proportion()
            const math = el.type === 'math-field';
            const name = bind(ctx, el, n => ({ kind: 'text', name: n, ...(math ? { math: true } : {}) }));
            note(ctx, el, 'kept', math ? 'Formelfeld → Gap, Anteile über proportion()' : undefined);
            return [`${indent}${name} = Gap(${str(labelOf(ctx, el))})`];
        }
        case 'text-area':
        case 'text-area-math': {
            const name = bind(ctx, el, n => ({ kind: 'text', name: n }));
            const math = el.type === 'text-area-math';
            note(ctx, el, 'kept', math ? 'Formeleingabe → FreeText mit Zeichenleiste' : undefined);
            const start = typeof el.value === 'string' && el.value !== '' ? `, initial: ${str(el.value)}` : '';
            return [`${indent}${name} = FreeText(${str(labelOf(ctx, el))}${start}${math ? `, keys: ${MATH_KEYS}` : ''})`];
        }
        case 'radio':
        case 'radio-group-images': {
            // Image options: the image is embedded in the unit (imgSrc); IQB provides no alt text
            const opts = el.options as { text?: string; imgSrc?: string | null; imgFileName?: string }[] | undefined ?? [];
            let missing = 0, unnamed = 0;
            const options = opts.map((o, i) => {
                const text = plain(o.text ?? '');
                if (o.imgSrc) {
                    if (text === '') unnamed++;
                    const path = o.imgSrc.startsWith('data:') ? ctx.media(o.imgSrc, o.imgFileName || `${el.alias}_${i + 1}`) : o.imgSrc;
                    return text !== '' ? `image(${str(path)}, ${str(text)})` : `image(${str(path)}, "")`;
                }
                if (text === '') missing++;
                return text !== '' ? str(text) : str(`Bild ${i + 1}`);
            });
            const name = bind(ctx, el, n => ({ kind: 'choice', name: n, options: options.length }));
            if (el.type === 'radio') note(ctx, el, 'kept');
            else if (missing > 0) note(ctx, el, 'approximated', 'Bildoptionen ohne Bild in der Unit → „Bild n“');
            else if (unnamed > 0) note(ctx, el, 'approximated', 'Bildoptionen ohne Alternativtext – ergänzen');
            else note(ctx, el, 'kept');
            return [`${indent}${name} = Choice(${str(labelOf(ctx, el))}, [${options.join(', ')}])`];
        }
        case 'checkbox': {
            const name = bind(ctx, el, n => ({ kind: 'check', name: n }));
            note(ctx, el, 'kept');
            return [`${indent}${name} = Check(${str(labelOf(ctx, el))})`];
        }
        case 'toggle-button':
        case 'dropdown': {
            const options = (el.options as { text?: string }[] | undefined ?? []).map(o => str(plain(o.text ?? '')));
            const name = bind(ctx, el, n => ({ kind: 'select', name: n, options: options.length }));
            note(ctx, el, el.type === 'dropdown' ? 'kept' : 'approximated',
                el.type === 'toggle-button' ? 'Umschalter (z. B. Schreibung durchstreichen) → Auswahlliste' : undefined);
            return [`${indent}${name} = Select(${str(labelOf(ctx, el))}, [${options.join(', ')}])`];
        }
        case 'likert': {
            const rows = (el.rows as AspectElement[] | undefined ?? []);
            const columns = (el.options as { text?: string }[] | undefined ?? []).map(o => str(plain(o.text ?? '')));
            const name = ctx.names.take(el.alias);
            rows.forEach((row, i) => ctx.answers.set(row.id, { kind: 'row', name, options: columns.length, index: i + 1 }));
            const labels = rows.map(r => str(plain(String((r.rowLabel as { text?: string } | undefined)?.text ?? r.alias))));
            note(ctx, el, 'kept');
            const label = typeof el.label === 'string' && plain(el.label) !== '' ? `, label: ${str(plain(el.label))}` : '';
            return [`${indent}${name} = Matrix(rows: [${labels.join(', ')}], columns: [${columns.join(', ')}]${label})`];
        }
        case 'drop-list': {
            const items = el.value as { id: string; alias: string; text: string }[] | undefined ?? [];
            if (items.length > 0 && !ctx.coded.has(el.id)) {
                // Pool: its cards are shown by the group around the slots (group(cards: …))
                const key = poolOf(ctx, el.id);
                note(ctx, el, key ? 'kept' : 'approximated', key ? 'Vorrat → Karten der Gruppe um die Plätze' : 'Ziehelemente ohne Ablage → weggelassen');
                return [];
            }
            const sources = dropSources(ctx, el);
            const name = bind(ctx, el, n => ({ kind: 'select', name: n, options: sources.length, items: sources.map(s => s.alias) }));
            const key = poolOf(ctx, firstSource(ctx, el));
            // Image cards: image as option; IQB provides no alt text
            const options = sources.map(s => s.img && !plain(s.text)
                ? `image(${str(s.img.startsWith('data:') ? ctx.media(s.img, s.alias) : s.img)}, "")`
                : str(plain(s.text) || s.alias));
            const images = sources.some(s => s.img && !plain(s.text));
            note(ctx, el, images ? 'approximated' : 'kept', images ? 'Ziehen und Ablegen → Select als Platz; Bildkarten ohne Alternativtext – ergänzen'
                : 'Ziehen und Ablegen → Select als Platz in group(cards: end)');
            // Each card at most once: the pool's other slots lock it (unless reuse)
            let taken = '';
            if (key && !key.reuse) {
                const token = `⟦taken:${key.name}⟧`;
                ctx.pools.set(key.name, [...ctx.pools.get(key.name) ?? [], name]);
                ctx.deferred.set(token, () => `[${(ctx.pools.get(key.name) ?? []).join(', ')}]`);
                taken = `, taken: ${token}`;
            }
            return [`${indent}${name} = Select(${str(labelOf(ctx, el))}, [${options.join(', ')}]${taken})`];
        }
        case 'cloze':
            return convertCloze(ctx, el, indent);
        case 'image': {
            const src = String(el.src ?? '');
            const alt = typeof el.alt === 'string' && el.alt !== 'Bild nicht gefunden' ? el.alt : '';
            note(ctx, el, alt !== '' ? 'kept' : 'approximated', alt !== '' ? undefined : 'kein Alternativtext (IQB: „Bild nicht gefunden“) – ergänzen');
            const path = src.startsWith('data:') ? ctx.media(src, String(el.fileName || el.alias)) : src;
            return [`${indent}image(${str(path)}, ${str(alt)})`];
        }
        case 'audio':
        case 'video': {
            const src = String(el.src ?? '');
            const player = (el.player ?? {}) as { maxRuns?: number; startControl?: boolean };
            const path = src.startsWith('data:') ? ctx.media(src, String(el.fileName || el.alias)) : src;
            ctx.audios.add(el.id);
            // As in the IQB player: the test taker starts playback, at most maxRuns times (0 = unlimited), no lock
            const plays = Math.max(0, player.maxRuns ?? 1);
            if (el.type === 'video') note(ctx, el, 'approximated', 'Video → Play; Untertitel (captions) ergänzen');
            else note(ctx, el, 'kept', 'Audio → Play');
            return [`${indent}Play(src: ${str(path)}, plays: ${plays})`];
        }
        case 'table': {
            const cells = el.elements as AspectElement[] | undefined ?? [];
            const rows = Math.max(0, ...cells.map(c => Number(c.gridRow) || 0), (el.gridRowSizes as unknown[] | undefined)?.length ?? 0);
            const cols = Math.max(0, ...cells.map(c => Number(c.gridColumn) || 0), (el.gridColumnSizes as unknown[] | undefined)?.length ?? 0);
            if (cells.length === 0 || cells.some(c => !Number(c.gridRow) || !Number(c.gridColumn))) {
                note(ctx, el, 'approximated', 'Tabelle ohne Zellpositionen: Zellen nacheinander');
                return cells.flatMap(child => convertElement(ctx, child, indent));
            }
            note(ctx, el, 'kept', 'Tabelle → table');
            const lines = [`${indent}table {`];
            for (let r = 1; r <= rows; r++) {
                lines.push(`${indent}${INDENT}row {`);
                for (let c = 1; c <= cols; c++) {
                    const inner = cells.filter(x => Number(x.gridRow) === r && Number(x.gridColumn) === c)
                        .flatMap(x => convertElement(ctx, x, indent + INDENT.repeat(3)));
                    lines.push(...(inner.length > 0 ? [`${indent}${INDENT.repeat(2)}cell {`, ...inner, `${indent}${INDENT.repeat(2)}}`] : [`${indent}${INDENT.repeat(2)}cell ""`]));
                }
                lines.push(`${indent}${INDENT}}`);
            }
            lines.push(`${indent}}`);
            return lines;
        }
        case 'frame':
            note(ctx, el, 'kept', 'Rahmen (nur Gestaltung) weggelassen');
            return [];
        case 'button':
        case 'trigger': {
            const control = [...ctx.flow.controls.values()].find(c => c.first === el);
            const how = ctx.flow.handled.get(el.id);
            if (how) note(ctx, el, how.fidelity, how.note);
            else note(ctx, el, 'missing', `${el.type}${el.action ? ` „${String(el.action)}“` : ''} weggelassen`);
            if (control && !ctx.emitted.has(control.state)) {
                ctx.emitted.add(control.state);
                return [`${indent}${control.line}`];
            }
            return [];
        }
        case 'geometry':
            return convertGeoGebra(ctx, el, indent);
        default:
            note(ctx, el, 'missing', 'kein Gegenstück');
            return [`${indent}p(tone: warning) ${str(`[nicht übernommen: ${el.type} ${el.alias}]`)}`];
    }
}

/** GeoGebra applet → plane (see geogebra.ts); draggable points as a generated component. */
function convertGeoGebra(ctx: Context, el: AspectElement, indent: string): string[] {
    const tracked = (el.trackedVariables as { id: string }[] | undefined ?? []).map(t => t.id);
    let geo;
    try {
        const pascal = ctx.item.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase());
        geo = translateGeoGebra(String(el.appDefinition ?? ''), {
            component: `Geo${pascal}${ctx.components.length > 0 ? ctx.components.length + 1 : ''}`,
            label: labelOf(ctx, el), tracked, media: ctx.media
        });
    } catch (e) {
        note(ctx, el, 'missing', `GeoGebra-Datei nicht lesbar (${e instanceof Error ? e.message : String(e)})`);
        return [`${indent}p(tone: warning) ${str(`[nicht übernommen: GeoGebra ${el.alias}]`)}`];
    }
    for (const n of geo.notes) note(ctx, el, n.fidelity, n.text);
    if (geo.kind === 'none') return geo.lines('', indent);
    const name = bind(ctx, el, n => ({ kind: 'drawing', name: n }));
    for (const [label, index] of geo.tracked) {
        // the IQB tracks a GeoGebra point as its own variable "<element>_<point>"
        ctx.answers.set(`${el.id}_${label}`, { kind: 'point', name, expr: `${name}[${index}]` });
    }
    if (geo.component.length > 0) ctx.components.push(geo.component);
    note(ctx, el, geo.notes.some(n => n.fidelity !== 'kept') ? 'approximated' : 'kept',
        geo.kind === 'board' ? 'GeoGebra → Zeichnen auf dem Raster (Geoboard)' : 'GeoGebra → Ebene mit ziehbaren Punkten');
    return geo.lines(name, indent);
}

/**
 * Pool of a drag list: all lists that fill the same slots form one pool (named after the first).
 * `reuse`: cards stay in the pool when dropped (copyOnDrop).
 */
function poolOf(ctx: Context, sourceId: string): { name: string; reuse: boolean } | undefined {
    const isSource = (e: AspectElement | undefined) => e?.type === 'drop-list' && (e.value as unknown[] | undefined ?? []).length > 0 && !ctx.coded.has(e.id);
    const sourcesOf = (t: AspectElement) => (t.connectedTo as string[] | undefined ?? []).filter(id => isSource(ctx.byId.get(id)));
    const targets = [...ctx.byId.values()].filter(e => e.type === 'drop-list' && !isSource(e) && sourcesOf(e).includes(sourceId));
    if (targets.length === 0) return undefined;
    const sources = [...ctx.byId.keys()].filter(id => targets.some(t => sourcesOf(t).includes(id)));
    return { name: ctx.byId.get(sources[0])!.alias, reuse: sources.some(id => ctx.byId.get(id)?.copyOnDrop === true) };
}

/** Whether the section contains drop targets (slots) filled from a pool. */
function hasSlots(ctx: Context, section: AspectSection): boolean {
    let found = false;
    const visit = (v: unknown): void => {
        if (found) return;
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object') {
            const o = v as AspectElement;
            if (o.type === 'drop-list' && !((o.value as unknown[] | undefined ?? []).length > 0 && !ctx.coded.has(o.id)) && firstSource(ctx, o) !== '') found = true;
            Object.values(o).forEach(visit);
        }
    };
    visit(section.elements);
    return found;
}

/** First drag list that fills a drop target. */
function firstSource(ctx: Context, target: AspectElement): string {
    return (target.connectedTo as string[] | undefined ?? []).find(id => {
        const e = ctx.byId.get(id);
        return e?.type === 'drop-list' && (e.value as unknown[] | undefined ?? []).length > 0 && !ctx.coded.has(id);
    }) ?? '';
}

/** All drag items of the lists that can fill a drop target. */
function dropSources(ctx: Context, target: AspectElement): { alias: string; text: string; img?: string }[] {
    const ids = (target.connectedTo as string[] | undefined ?? []);
    const items: { alias: string; text: string; img?: string }[] = [];
    for (const id of ids) {
        const list = ctx.byId.get(id);
        for (const item of (list?.value as { alias: string; text: string; imgSrc?: string }[] | undefined ?? [])) {
            if (!items.some(i => i.alias === item.alias)) items.push({ alias: item.alias, text: item.text, ...(item.imgSrc ? { img: item.imgSrc } : {}) });
        }
    }
    return items;
}

interface ClozeNode { type: string; text?: string; marks?: { type: string }[]; attrs?: Record<string, unknown>; content?: ClozeNode[] }

/** Cloze text: paragraphs with text and embedded fields. */
function convertCloze(ctx: Context, el: AspectElement, indent: string): string[] {
    const doc = el.document as ClozeNode | undefined;
    const lines: string[] = [];
    note(ctx, el, 'kept');
    for (const para of doc?.content ?? []) {
        const parts: string[] = [];
        let text = '';
        let said = '';   // paragraph text so far, used to label gaps
        let fields = false;
        const flush = () => { if (text !== '') parts.push(str(text)); text = ''; };
        const visit = (node: ClozeNode, marks: string[] = []): void => {
            if (node.type === 'text') {
                const m = [...marks, ...(node.marks ?? []).map(x => x.type)];
                const wrap = m.includes('bold') ? 'strong' : m.includes('italic') ? 'emph' : m.includes('superscript') ? 'sup' : m.includes('subscript') ? 'sub' : '';
                if (wrap) { flush(); parts.push(`${wrap}(${str(node.text ?? '')})`); } else text += node.text ?? '';
                said += node.text ?? '';
                return;
            }
            if (node.type === 'hardBreak') { text += ' '; said += ' '; return; }
            if (node.type === 'math-formula') { flush(); parts.push(`math(${verbatim(String(node.attrs?.formula ?? ''))})`); return; }
            const model = node.attrs?.model as AspectElement | undefined;
            if (model) {
                if (plain(said) !== '') ctx.prompt = plain(said);
                flush();
                fields = true;
                parts.push(...convertElement(ctx, model, '').map(l => l.trim()).filter(l => l !== ''));
                return;
            }
            for (const child of node.content ?? []) visit(child, marks);
        };
        visit(para);
        flush();
        // A paragraph without a field becomes the prompt that labels the following gaps
        if (!fields && plain(said) !== '') ctx.prompt = plain(said);
        const cleaned = parts.filter(p => p !== '""' && p !== '" "');
        if (cleaned.length > 0) lines.push(`${indent}p { ${cleaned.join(' ')} }`);
    }
    return lines;
}

type Rule = { id: string; operator: string; value: string };

/** A rule over a response or an audio element; undefined if it does not refer to one. */
function answerRule(ctx: Context, rule: Rule): string | undefined {
    const { operator: op, value: v } = rule;
    if (ctx.audios.has(rule.id)) {
        const n = Number(v) || 0;
        if (op === '>') return `heard() > ${n}`;
        if (op === '≥') return `heard() >= ${n}`;
        if (op === '=') return `heard() == ${n}`;
    }
    const answer = ctx.answers.get(rule.id);
    if (!answer) return undefined;
    // "≠ empty", "> 0", "minLength": answered
    if ((v === '' || v == null) && (op === '=' || op === '≠')) return `${op === '=' ? 'not ' : ''}changed(${answer.name})`;
    if (op === 'minLength' || ((op === '>' && Number(v) === 0) || (op === '≥' && Number(v) === 1))) {
        return answer.kind === 'row' ? `${answer.name}[${answer.index}] != none` : `changed(${answer.name})`;
    }
    const n = answer.kind === 'select' && answer.items ? option(answer.items.indexOf(v) + 1) : option(v);
    if (answer.kind === 'choice' && n !== undefined) {
        if (op === '=' || op === 'contains') return `${n} in ${answer.name}`;
        if (op === '≠') return `not (${n} in ${answer.name})`;
    }
    if ((answer.kind === 'select' || answer.kind === 'row') && n !== undefined) {
        const ref = answer.kind === 'row' ? `${answer.name}[${answer.index}]` : answer.name;
        const cmp: Record<string, string> = { '=': '==', '≠': '!=', '>': '>', '≥': '>=', '<': '<', '≤': '<=' };
        if (cmp[op]) return `${ref} ${cmp[op]} ${n}`;
    }
    if (answer.kind === 'text') {
        if (op === '=') return `${answer.name} == ${str(v)}`;
        if (op === '≠') return `${answer.name} != ${str(v)}`;
        if (op === 'contains') return `accept(${answer.name}, ${verbatim(`(…) ${v} (…)`)})`;
    }
    if (answer.kind === 'check' && (op === '=' || op === '≠')) return `${answer.name} ${op === '=' ? '==' : '!='} ${v === 'true'}`;
    return undefined;
}

function join(parts: string[], conj: boolean): string {
    return parts.length === 1 ? parts[0] : parts.map(p => `(${p})`).join(conj ? ' and ' : ' or ');
}

/** Section condition built only from rules over responses (for triggers inside); undefined without such rules. */
function answerCondition(ctx: Context, section: AspectSection): string | undefined {
    const parts = (section.visibilityRules ?? []).map(r => answerRule(ctx, r)).filter((x): x is string => x !== undefined);
    return parts.length > 0 ? join(parts, section.logicalConnectiveOfRules === 'conjunction') : undefined;
}

/**
 * Visibility rules of a section as a condition for `show(when:)`. Responses of later sections are not known yet,
 * so a placeholder is emitted and replaced after the full pass.
 */
export function visibility(ctx: Context, section: AspectSection): string | undefined {
    const rules = section.visibilityRules ?? [];
    const delay = Number(section.visibilityDelay ?? 0);
    if (delay > 0) ctx.report.push({ element: 'Abschnitt', type: 'visibilityDelay', fidelity: 'kept', note: `bewusst: erscheint sofort statt nach ${Math.round(delay / 1000)} s` });
    if (rules.length === 0) return undefined;
    const token = `⟦${ctx.deferred.size}⟧`;
    ctx.deferred.set(token, () => {
        const parts = rules.map(rule => {
            const state = ctx.flow.stateRule(rule.id, rule.operator, rule.value, s => answerCondition(ctx, s));
            if (state !== undefined) {
                ctx.report.push({ element: rule.id, type: 'visibilityRule', fidelity: 'kept', note: 'Zustand → Bedingung' });
                return state;
            }
            const expr = answerRule(ctx, rule);
            if (expr !== undefined) return expr;
            ctx.report.push({ element: rule.id, type: 'visibilityRule', fidelity: 'missing', note: `Regel ${rule.operator} ${rule.value} nicht übersetzt (immer sichtbar)` });
            return 'true';
        });
        return join(parts, section.logicalConnectiveOfRules === 'conjunction');
    });
    return token;
}

/** Elements of a section in reading order (grid row, then column); rows with several columns → `row`. */
export function convertSection(ctx: Context, section: AspectSection, indent: string): string[] {
    const pos = (e: AspectElement) => (e.position ?? {}) as { gridRow?: number | null; gridColumn?: number | null; yPosition?: number; xPosition?: number };
    const sorted = [...section.elements ?? []].sort((a, b) =>
        ((pos(a).gridRow ?? 0) - (pos(b).gridRow ?? 0)) || ((pos(a).gridColumn ?? 0) - (pos(b).gridColumn ?? 0)) ||
        ((pos(a).yPosition ?? 0) - (pos(b).yPosition ?? 0)) || ((pos(a).xPosition ?? 0) - (pos(b).xPosition ?? 0)));
    const lines: string[] = [];
    for (let i = 0; i < sorted.length;) {
        const rowNo = pos(sorted[i]).gridRow;
        let j = i + 1;
        while (j < sorted.length && rowNo != null && pos(sorted[j]).gridRow === rowNo) j++;
        // Lines per element; elements without output (frames, buttons) are dropped
        const columns = sorted.slice(i, j).map(e => convertElement(ctx, e, indent)).filter(c => c.length > 0);
        if (columns.length > 1) {
            lines.push(`${indent}row {`);
            for (const c of columns) lines.push(`${indent}${INDENT}section {`, ...c.map(l => INDENT + INDENT + l), `${indent}${INDENT}}`);
            lines.push(`${indent}}`);
        } else if (columns.length === 1) {
            lines.push(...columns[0]);
        }
        i = j;
    }
    return lines;
}

/** Controls (buttons) whose section depends on their own state; hoisted before the section. */
function hoisted(ctx: Context, section: AspectSection): string[] {
    const own = new Set((section.visibilityRules ?? []).map(r => r.id));
    const out: string[] = [];
    for (const control of ctx.flow.controls.values()) {
        if (ctx.emitted.has(control.state) || !own.has(control.state)) continue;
        if (!JSON.stringify(section.elements).includes(`"${control.first.id}"`)) continue;
        ctx.emitted.add(control.state);
        out.push(control.line);
    }
    return out;
}

/** Converts all pages of the unit into the lines of the item body. */
export function convertUnitBody(ctx: Context): string[] {
    const pages = ctx.unit.definition.pages ?? [];
    const stimulus = pages.filter(p => p.alwaysVisible);
    const normal = pages.filter(p => !p.alwaysVisible);
    const lines: string[] = [];
    const section = (sec: AspectSection, indent: string) => {
        const lifted = hoisted(ctx, sec).map(l => indent + l);
        const cond = visibility(ctx, sec);
        const body = convertSection(ctx, sec, cond ? indent + INDENT : indent);
        if (body.length === 0) return lifted;
        return [...lifted, ...(cond ? [`${indent}show(when: ${cond}) {`, ...body, `${indent}}`] : body)];
    };
    // Sections with drop slots (from first to last) go into one group that shows the cards
    const sections = (secs: AspectSection[] = [], indent: string) => {
        const slots = secs.map(s => JSON.stringify(s.elements).includes('"drop-list"') && hasSlots(ctx, s));
        const first = slots.indexOf(true), last = slots.lastIndexOf(true);
        return secs.flatMap((sec, i) => {
            if (first < 0 || i < first || i > last) return section(sec, indent);
            const inner = section(sec, indent + INDENT);
            return [...(i === first ? [`${indent}group(cards: end) {`] : []), ...inner, ...(i === last ? [`${indent}}`] : [])];
        });
    };
    for (const page of stimulus) {
        const body = sections(page.sections, INDENT + INDENT);
        if (body.length > 0) lines.push(`${INDENT}stimulus(label: ${str(ctx.unit.label)}) {`, ...body, `${INDENT}}`);
    }
    if (normal.length === 1) lines.push(...sections(normal[0].sections, INDENT));
    else for (const page of normal) {
        const body = sections(page.sections, INDENT + INDENT);
        // Keep empty pages only if current_page() counts the IQB pages
        // an empty page stays (conditions count pages) and is written as the formatter writes it
        if (body.length > 0) lines.push(`${INDENT}page {`, ...body, `${INDENT}}`);
        else if (ctx.flow.countsPages) lines.push(`${INDENT}page { }`);
    }
    // Resolve visibility placeholders; always-true conditions are dropped
    const resolved = new Map([...ctx.deferred].map(([k, f]) => [k, f()]));
    const out: string[] = [];
    let skip: string | undefined;
    for (const line of lines) {
        const m = /^(\s*)show\(when: (⟦\d+⟧)\) \{$/.exec(line);
        if (m && resolved.get(m[2]) === 'true') { skip = m[1]; continue; }
        if (skip !== undefined && line === `${skip}}`) { skip = undefined; continue; }
        const text = skip !== undefined && line.startsWith(skip + INDENT) ? skip + line.slice(skip.length + INDENT.length) : line;
        out.push(text.replace(/⟦[^⟧]+⟧/g, k => resolved.get(k) ?? 'true'));
    }
    return out;
}
