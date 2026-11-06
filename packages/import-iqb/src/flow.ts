// Flow control of an Aspect unit: state variables (set by buttons and triggers) and per-page text highlights.
// AF items have no events, so these become button responses (`Button`, `Tabs`) and conditions on `current_page()`.

import { plain } from './html.js';
import { str } from './text.js';
import type { AspectElement, AspectSection, IqbUnit } from './unit.js';

interface Place {
    /** AF page (1-based); 0 = material (always visible). */
    page: number;
    section: AspectSection;
}

interface Setter extends Place {
    el: AspectElement;
    value: string;
    /** Button label. */
    label: string;
    /** ID of the text element the label was taken from. */
    labelFrom?: string;
}

/** Buttons controlling a state variable, emitted as one AF response in place of the first button. */
export interface Control {
    state: string;
    name: string;
    /** AF statement that replaces the first button. */
    line: string;
    first: AspectElement;
    /** Variable value → AF condition. */
    is: Map<string, string>;
}

/** Result of `analyzeFlow`. */
export interface Flow {
    /** Number of pages of the AF item (excluding material). */
    pages: number;
    /** Conditions count pages (current_page()), so empty pages must be kept. */
    countsPages: boolean;
    controls: Map<string, Control>;
    /** Button/trigger ID → how it was adopted. */
    handled: Map<string, { fidelity: 'kept' | 'approximated'; note: string }>;
    /** Anchor ID → condition under which the passage is highlighted. */
    anchors: Map<string, string>;
    /** IDs of texts used as button labels (omitted at their original position). */
    labels: Set<string>;
    /** Condition for "variable op value"; undefined if `id` is not a state variable. */
    stateRule(id: string, operator: string, value: string, answer: (section: AspectSection) => string | undefined): string | undefined;
}

function walk(value: unknown, visit: (el: AspectElement) => void): void {
    if (Array.isArray(value)) value.forEach(v => walk(v, visit));
    else if (value && typeof value === 'object') {
        const o = value as Record<string, unknown>;
        if (typeof o.type === 'string' && typeof o.id === 'string') visit(o as AspectElement);
        for (const v of Object.values(o)) walk(v, visit);
    }
}

/** Pages as `current_page() in {…}`; all pages → true, none → false. */
function onPages(pages: number[], total: number): string {
    const set = [...new Set(pages)].filter(p => p >= 1).sort((a, b) => a - b);
    if (set.length === 0) return 'false';
    if (total <= 1 || set.length === total) return 'true';
    return set.length === 1 ? `current_page() == ${set[0]}` : `current_page() in {${set.join(', ')}}`;
}

function or(parts: string[]): string {
    const p = [...new Set(parts)].filter(x => x !== 'false');
    if (p.includes('true')) return 'true';
    if (p.length === 0) return 'false';
    return p.length === 1 ? p[0] : p.map(x => `(${x})`).join(' or ');
}

function and(a: string, b: string): string {
    if (a === 'false' || b === 'false') return 'false';
    if (a === 'true') return b;
    if (b === 'true') return a;
    return `(${a}) and (${b})`;
}

function not(a: string): string {
    return a === 'true' ? 'false' : a === 'false' ? 'true' : `not (${a})`;
}

/** Button label: its own, else the preceding text in the section (e.g. "weiter"; `from`: that text's ID). */
function buttonLabel(el: AspectElement, section: AspectSection): { label: string; from?: string } {
    const own = plain(String(el.label ?? ''));
    if (own !== '') return { label: own };
    const i = section.elements.indexOf(el);
    for (let k = i - 1; k >= 0; k--) {
        const e = section.elements[k];
        if (e.type === 'text') {
            const t = plain(String(e.text ?? ''));
            if (t !== '') return { label: t, from: e.id };
        }
    }
    return { label: 'Weiter' };
}

/** Analyzes buttons, triggers and highlights of a unit; `take` assigns AF names. */
export function analyzeFlow(unit: IqbUnit, take: (alias: string) => string): Flow {
    const def = unit.definition;
    const normal = def.pages.filter(p => !p.alwaysVisible);
    const pages = normal.length;
    const initial = new Map((def.stateVariables ?? []).map(s => [s.id, String(s.value ?? '0')]));
    const alias = new Map((def.stateVariables ?? []).map(s => [s.id, s.alias ?? s.id]));
    const presses = new Map<string, Setter[]>();
    const triggers = new Map<string, Setter[]>();
    const handled: Flow['handled'] = new Map();
    // Highlights: the actions per page, in order
    const marks: { page: number; action: 'add' | 'clear'; anchor?: string; el: AspectElement }[] = [];
    // Buttons that highlight a passage on click (older units, e.g. "Abschnitt 2")
    const pointers: { anchor: string; el: AspectElement; section: AspectSection }[] = [];

    let n = 0;
    for (const page of def.pages) {
        const number = page.alwaysVisible ? 0 : ++n;
        for (const section of page.sections) {
            walk(section.elements, el => {
                if (el.type !== 'button' && el.type !== 'trigger') return;
                const action = String(el.action ?? '');
                const param = el.actionParam as { id?: string; value?: string } | string | null | undefined;
                if (action === 'stateVariableChange' && param && typeof param === 'object' && param.id && initial.has(param.id)) {
                    const { label, from } = buttonLabel(el, section);
                    const setter: Setter = { page: number, section, el, value: String(param.value ?? ''), label, ...(from ? { labelFrom: from } : {}) };
                    const into = el.type === 'button' ? presses : triggers;
                    into.set(param.id, [...into.get(param.id) ?? [], setter]);
                } else if (el.type === 'trigger' && action === 'highlightText' && typeof param === 'string') {
                    marks.push({ page: number, action: 'add', anchor: param, el });
                } else if (el.type === 'button' && action === 'highlightText' && typeof param === 'string') {
                    pointers.push({ anchor: param, el, section });
                } else if (el.type === 'trigger' && action === 'removeHighlights') {
                    marks.push({ page: number, action: 'clear', el });
                } else if (el.type === 'button' && (action === 'unitNav' || action === 'pageNav')) {
                    handled.set(el.id, { fidelity: 'kept', note: 'Navigation übernimmt die Runtime' });
                } else if (el.type === 'button' && action === '') {
                    handled.set(el.id, { fidelity: 'kept', note: 'Knopf ohne Aktion weggelassen' });
                }
            });
        }
    }

    // Buttons: one value besides the initial one → Button; several values → Tabs
    const controls = new Map<string, Control>();
    const labels = new Set<string>();
    for (const [id, setters] of presses) {
        const v0 = initial.get(id)!;
        const values = [...new Set([v0, ...setters.map(s => s.value)])];
        const name = take(alias.get(id)!);
        const is = new Map<string, string>();
        let line: string;
        const labelOf = (v: string) => [...new Set(setters.filter(s => s.value === v).map(s => s.label))];
        // A single value (a start button like "weiter") or toggling with the same label ("hier") → Button, else Tabs
        const toggle = values.length === 2 && (!setters.some(s => s.value === v0) || labelOf(v0).join() === labelOf(values[1]).join());
        if (toggle) {
            const v1 = values[1];
            const once = !setters.some(s => s.value === v0);
            const label = setters.find(s => s.value === v1)!.label;
            line = `${name} = Button(${str(label)}${once ? ', once: true' : ''})`;
            is.set(v1, name);
            is.set(v0, `not ${name}`);
        } else {
            const labels = values.map(v => setters.find(s => s.value === v)?.label ?? `Ansicht ${v}`);
            line = `${name} = Tabs(label: ${str(alias.get(id)!)}, options: [${labels.map(str).join(', ')}])`;
            values.forEach((v, i) => is.set(v, `${name} == ${i + 1}`));
        }
        controls.set(id, { state: id, name, line, first: setters[0].el, is });
        for (const s of setters) if (s.labelFrom) labels.add(s.labelFrom);
        for (const s of setters) handled.set(s.el.id, { fidelity: 'kept', note: s.el === setters[0].el ? `Knopf → ${line.split(' = ')[1].split('(')[0]}` : 'Knopf in der Steuerung zusammengefasst' });
        for (const t of triggers.get(id) ?? []) handled.set(t.el.id, { fidelity: 'kept', note: 'bewusst: Trigger setzt den Zustand nicht mehr, der Knopf entscheidet' });
    }

    // Triggers: value per page (the last unconditional trigger up to that page wins) plus conditional triggers
    const stateIs = new Map<string, (value: string, answer: (s: AspectSection) => string | undefined) => string>();
    for (const [id, setters] of triggers) {
        if (controls.has(id)) continue;
        const v0 = initial.get(id)!;
        stateIs.set(id, (value, answer) => {
            const plainSetters = setters.filter(s => answer(s.section) === undefined);
            const pageValue = (p: number) => {
                let v = v0;
                for (const s of plainSetters) if (s.page <= p) v = s.value;
                return v;
            };
            const all = Array.from({ length: Math.max(1, pages) }, (_, i) => i + 1);
            const base = onPages(all.filter(p => pageValue(p) === value), Math.max(1, pages));
            const conditional = setters.filter(s => answer(s.section) !== undefined);
            const to = or(conditional.filter(s => s.value === value).map(s => answer(s.section)!));
            const away = or(conditional.filter(s => s.value !== value).map(s => answer(s.section)!));
            return or([and(base, not(away)), to]);
        });
        for (const s of setters) {
            const delay = Number(s.section.visibilityDelay ?? 0);
            handled.set(s.el.id, delay > 0
                ? { fidelity: 'kept', note: `Trigger übersetzt; bewusst ohne Verzögerung (${Math.round(delay / 1000)} s)` }
                : { fidelity: 'kept', note: 'Trigger → Bedingung über Seite bzw. Antworten' });
        }
    }

    // Highlights: set of anchors per page; pages without an action keep the previous set
    const active = new Map<string, number[]>();
    let current = new Set<string>();
    for (let p = 0; p <= Math.max(1, pages); p++) {
        const here = marks.filter(m => m.page === p);
        for (const m of here) {
            if (m.action === 'clear') current = new Set();
            else current.add(m.anchor!);
        }
        if (p >= 1) for (const a of current) active.set(a, [...active.get(a) ?? [], p]);
    }
    const anchors = new Map([...active].map(([a, ps]) => [a, onPages(ps, Math.max(1, pages))]));
    for (const m of marks) handled.set(m.el.id, { fidelity: 'kept', note: 'Hervorhebung → mark(…) mit current_page()' });
    // Highlight buttons: a toggle Button each; the passage is marked while one of its buttons is pressed
    for (const { anchor, el, section } of pointers) {
        const { label } = buttonLabel(el, section);
        const name = take(label.replace(/[:,.]+$/, '') || String(el.alias ?? el.id));
        const line = `${name} = Button(${str(label)})`;
        controls.set(`highlight:${el.id}`, { state: `highlight:${el.id}`, name, line, first: el, is: new Map() });
        anchors.set(anchor, or([anchors.get(anchor) ?? 'false', name]));
        handled.set(el.id, { fidelity: 'approximated', note: 'Knopf hebt Textstelle hervor → Button (Umschalter) und mark(…)' });
    }

    return {
        pages, controls, handled, anchors, labels,
        countsPages: anchors.size > 0 || [...triggers.keys()].some(id => !controls.has(id)),
        stateRule(id, operator, value, answer) {
            if (!initial.has(id)) return undefined;
            const control = controls.get(id);
            const known = control ? [...control.is.keys()]
                : [...new Set([initial.get(id)!, ...(triggers.get(id) ?? []).map(s => s.value)])];
            const is = (v: string) => control ? control.is.get(v) ?? 'false' : stateIs.get(id)?.(v, answer) ?? (v === initial.get(id) ? 'true' : 'false');
            const num = Number(value);
            const match = known.filter(v => operator === '=' ? v === value : operator === '≠' ? v !== value
                : operator === '>' ? Number(v) > num : operator === '≥' ? Number(v) >= num
                : operator === '<' ? Number(v) < num : operator === '≤' ? Number(v) <= num : false);
            return or(match.map(is));
        }
    };
}
