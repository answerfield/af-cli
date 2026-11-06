// IQB coding scheme → AF coding. Rules become expressions over the AF responses (see Answer in convert.ts).

import type { Answer, Context } from './convert.js';
import { plain } from './html.js';
import { option, shorten, str, verbatim } from './text.js';
import type { CodingCode, CodingRule, VariableCoding } from './unit.js';

/** Deliberately differs from IQB but never worse (verified by the comparison test), so it counts as adopted. */
const NUMBER_NOTE = 'number() liest mehr Schreibweisen als das IQB (wie die Auswertungsanleitungen)';

const CREDIT = new Set(['FULL_CREDIT', 'PARTIAL_CREDIT', 'INTENDED_INCOMPLETE', 'NO_CREDIT', 'UNSET']);

/** Comparisons of the NUMERIC rules: one operator per parameter. */
const COMPARE: Record<string, string[]> = {
    NUMERIC_MIN: ['>='], NUMERIC_MAX: ['<='], NUMERIC_MORE_THAN: ['>'], NUMERIC_LESS_THAN: ['<'],
    NUMERIC_RANGE: ['>', '<='], NUMERIC_FULL_RANGE: ['>=', '<=']
};

/** Preprocessing as in @iqb/responses (transformString). */
function iqbTransform(text: string, processing: string[]): string {
    let s = text;
    if (processing.includes('IGNORE_ALL_SPACES') || processing.includes('REMOVE_ALL_SPACES')) s = s.replace(/\s+/g, '');
    if (processing.includes('IGNORE_DISPENSABLE_SPACES') || processing.includes('REMOVE_DISPENSABLE_SPACES')) s = s.trim().replace(/\s+/g, ' ');
    if (processing.includes('IGNORE_CASE') || processing.includes('TO_LOWER_CASE')) s = s.toLowerCase();
    return s;
}

/** Expression for a response's value (matrix row: index into the list). */
function ref(answer: Answer): string {
    return answer.kind === 'row' ? `${answer.name}[${answer.index}]` : answer.name;
}

function values(rule: CodingRule): string[] {
    return (rule.parameters ?? []).flatMap(p => String(p).split(/\r?\n/)).filter(p => p !== '');
}

/** Number in a rule parameter as an AF number ("2,5" → 2.5), else undefined. */
function numeral(x: string | undefined): string | undefined {
    const n = x?.replace(',', '.').replace(/\s+/g, '');
    return n !== undefined && /^-?\d+(\.\d+)?$/.test(n) ? n : undefined;
}

function oneOf(lhs: string, rhs: string[]): string {
    if (rhs.length === 0) return 'false';
    return rhs.length === 1 ? `${lhs} == ${rhs[0]}` : `${lhs} in {${rhs.join(', ')}}`;
}

/** Word numbers (1-based) from highlight ranges "start-end-color" (0-based words). */
function words(param: string): number[] {
    const m = /^,?(\d+)-(\d+)-/.exec(param);
    if (!m) return [];
    const out: number[] = [];
    for (let k = Number(m[1]); k <= Number(m[2]); k++) out.push(k + 1);
    return out;
}

interface Translation { expr: string; note?: string }

function translateRule(rule: CodingRule, answer: Answer, processing: string[]): Translation {
    const v = values(rule);
    const lhs = ref(answer);
    const manual = (why: string): Translation =>
        ({ expr: `manual(${verbatim(`${rule.method} ${v.join(' | ')}`)})`, note: `${why} → Kodierende` });
    // For choices, NUMERIC_MATCH also compares the option number
    const method = rule.method === 'NUMERIC_MATCH' && answer.kind !== 'text' ? 'MATCH' : rule.method;
    const nums = v.map(numeral);
    const ops = COMPARE[method];
    if (ops) {
        if (!ops.every((_, k) => nums[k] !== undefined)) return manual(`${method}: Grenze ist keine Zahl`);
        return { expr: ops.map((op, k) => `number(${lhs}) ${op} ${nums[k]}`).join(' and '), note: NUMBER_NOTE };
    }
    switch (method) {
        case 'MATCH': {
            if (answer.kind === 'check') return { expr: `${lhs} == ${v[0] === 'true'}` };
            if (answer.kind === 'choice' || answer.kind === 'row' || answer.kind === 'select') {
                const items = answer.kind === 'select' ? answer.items : undefined;
                const indexes = v.map(x => option(items ? items.indexOf(x) + 1 : x));
                if (indexes.some(n => n === undefined)) return manual('Wert passt zu keiner Option');
                return { expr: oneOf(lhs, indexes.map(n => answer.kind === 'choice' ? `{${n}}` : String(n))) };
            }
            const caseless = processing.includes('IGNORE_CASE') || processing.includes('TO_LOWER_CASE');
            const spaces = processing.some(p => p.endsWith('ALL_SPACES')) ? 'remove'
                : processing.some(p => p.endsWith('DISPENSABLE_SPACES')) ? 'collapse' : '';
            const args = [caseless ? 'case: false' : '', spaces ? `spaces: ${spaces}` : ''].filter(Boolean);
            const subject = args.length > 0 ? `normalize(${lhs}, ${args.join(', ')})` : lhs;
            return { expr: oneOf(subject, [...new Set(v.map(x => str(iqbTransform(x, processing))))]) };
        }
        case 'NUMERIC_MATCH':
            if (nums.some(n => n === undefined)) return manual('NUMERIC_MATCH: Wert ist keine Zahl');
            return { expr: oneOf(`number(${lhs})`, nums as string[]), note: NUMBER_NOTE };
        case 'IS_TRUE': return { expr: `${lhs} == true` };
        case 'IS_FALSE': return { expr: `${lhs} == false` };
        default:
            return manual(`Regelart ${rule.method} nicht übersetzt`);
    }
}

/** Formula field: a rule parameter's LaTeX as one would type it (\frac35 → 3/5, 60\% → 60%, 3\colon10 → 3:10). */
export function typed(param: string): string {
    return param.replace(/\\%/g, '%').replace(/\\colon/g, ':').replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2')
        .replace(/\\frac(\d)(\d)/g, '$1/$2').replace(/\\left|\\right/g, '').replace(/[{}]/g, '');
}

/** Value of a typed proportion (fraction, ratio, percent, decimal) as a reduced fraction "n/d". */
function shareValue(text: string): string | undefined {
    const s = text.replace(/\s+/g, '');
    let n: bigint, d: bigint;
    let m = /^(\d+)[/:](\d+)$/.exec(s);
    if (m) { n = BigInt(m[1]); d = BigInt(m[2]); }
    else {
        m = /^(\d+)(?:[,.](\d+))?(%?)$/.exec(s);
        if (!m) return undefined;
        n = BigInt(m[1] + (m[2] ?? ''));
        d = 10n ** BigInt((m[2] ?? '').length) * (m[3] ? 100n : 1n);
    }
    if (d === 0n) return undefined;
    const gcd = (a: bigint, b: bigint): bigint => b === 0n ? a : gcd(b, a % b);
    const g = gcd(n, d) || 1n;
    return d / g === 1n ? `${n / g}` : `${n / g}/${d / g}`;
}

/**
 * Code with typed instead of LaTeX parameters; `keep` filters parameters. Number rules become spelling matches
 * ("0,6" or "0.6"): number() would also read "3/5" as 0.6, IQB does not.
 */
function typedCode(code: CodingCode, keep?: (text: string) => boolean): CodingCode {
    const decimal = (v: string) => /^\d+[,.]\d+$/.test(v) ? [v.replace('.', ','), v.replace(',', '.')] : [v];
    return { ...code, ruleSets: (code.ruleSets ?? []).map(rs => ({ ...rs, rules: rs.rules
        .map(r => ({ ...r, ...(r.method === 'NUMERIC_MATCH' ? { method: 'MATCH' } : {}),
            parameters: values(r).map(typed).filter(v => !keep || keep(v)).flatMap(v => r.method === 'NUMERIC_MATCH' ? decimal(v) : [v]) }))
        .filter(r => (r.parameters ?? []).length > 0) })).filter(rs => rs.rules.length > 0) };
}

/** Exact proportion of a code: from a fraction, ratio or percent, else from the decimal. */
function exactShare(code: CodingCode): string | undefined {
    const texts = (code.ruleSets ?? []).flatMap(rs => rs.rules).filter(r => r.method === 'MATCH' || r.method === 'NUMERIC_MATCH')
        .flatMap(values).map(typed);
    const exact = texts.find(t => /[/:%]/.test(t) && shareValue(t)) ?? texts.find(t => shareValue(t));
    return exact ? shareValue(exact) : undefined;
}

/** Condition of a code over the response; undefined if the code has no rules. */
function translateCode(code: CodingCode, answer: Answer, processing: string[], notes: string[], fragmenting = ''): string | undefined {
    const ruleSets = code.ruleSets ?? [];
    // Drawings are judged by the human coder (the rules, if any, compare GeoGebra's internal state)
    if (answer.kind === 'drawing') return undefined;
    if (answer.kind === 'point') return pointCode(code, answer.expr, notes, axesOf(fragmenting));
    if (answer.kind === 'text' && answer.math !== undefined) {
        // Formula field: compare the proportion via proportion(), plus any other listed values (e.g. rounded) as typed
        const plainAnswer: Answer = { kind: 'text', name: answer.name };
        // Ignore leading/trailing spaces (IQB does so only for numbers; AF treats all spellings alike)
        const spaces = processing.some(p => p.endsWith('SPACES')) ? processing : [...processing, 'IGNORE_DISPENSABLE_SPACES'];
        const value = answer.math ? exactShare(code) : undefined;
        if (!value) return translateCode(typedCode(code), plainAnswer, spaces, notes);
        const rest = typedCode(code, v => shareValue(v) !== value);
        const more = (rest.ruleSets ?? []).length > 0 ? translateCode(rest, plainAnswer, spaces, notes) : undefined;
        return more ? `proportion(${answer.name}) == ${value} or ${more}` : `proportion(${answer.name}) == ${value}`;
    }
    if (answer.kind === 'words') {
        // Highlighting: per rule set exactly the listed ranges (no others, as IQB enforces via the count)
        const sets = ruleSets.map(rs => [...new Set(rs.rules.filter(r => r.method === 'MATCH').flatMap(r => values(r).flatMap(words)))])
            .filter(w => w.length > 0);
        if (sets.length === 0) {
            notes.push('Markierung ohne Wortbereiche (Regeln auf Anzahl oder Text) → Kodierende');
            return `manual(${str(`Markierung prüfen (Code ${Number(code.id)})`)})`;
        }
        notes.push('Markierung: Bereiche als Wortnummern (Wortzählung prüfen)');
        return sets.map(w => `${answer.name} == {${w.sort((a, b) => a - b).join(', ')}}`).join(' or ');
    }
    const sets = ruleSets.map(rs => {
        if (rs.valueArrayPos !== undefined && rs.valueArrayPos !== null) notes.push('valueArrayPos nicht übersetzt');
        // Several MATCH rules joined by "or" form a list of accepted responses
        const merged = !rs.ruleOperatorAnd && rs.rules.length > 1 && rs.rules.every(r => r.method === 'MATCH' && (r.fragment ?? -1) === -1)
            ? [{ method: 'MATCH', parameters: rs.rules.flatMap(r => r.parameters ?? []) }] : rs.rules;
        const rules = merged.map(r => {
            if (r.fragment !== undefined && r.fragment !== null && r.fragment !== -1) notes.push('Fragmente nicht übersetzt');
            const t = translateRule(r, answer, processing);
            if (t.note) notes.push(t.note);
            return t.expr;
        });
        if (rules.length === 0) return undefined;
        return rules.length === 1 ? rules[0] : `(${rules.join(rs.ruleOperatorAnd ? ' and ' : ' or ')})`;
    }).filter((x): x is string => x !== undefined);
    if (sets.length === 0) return undefined;
    return sets.length === 1 ? sets[0] : sets.map(s => `(${s})`).join(code.ruleSetOperatorAnd ? ' and ' : ' or ');
}

/**
 * Coordinate of each fragment of a GeoGebra point: capture groups before the separator ("|" or ",") are x, after it
 * y, e.g. `I\((\d+) \| (\d+)\)` → [x, y], `E = \((\d+), \d+\)` → [x].
 */
function axesOf(fragmenting: string): Array<'x' | 'y'> {
    const axes: Array<'x' | 'y'> = [];
    let axis: 'x' | 'y' = 'x';
    for (let i = 0; i < fragmenting.length; i++) {
        const c = fragmenting[i];
        if (c === '\\') { if (fragmenting[i + 1] === '|') axis = 'y'; i++; continue; }
        if (c === ',' && axes.length > 0) axis = 'y';
        if (c === '(' && fragmenting[i + 1] !== '?') axes.push(axis);
    }
    return axes;
}

/**
 * Rules on a GeoGebra point the IQB tracks as text (e.g. "I(13.2 | 0)"), split into coordinates by `fragmenting`.
 * Numbers compare exactly; the AF value snaps to the same grid as the applet.
 */
function pointCode(code: CodingCode, expr: string, notes: string[], axes: Array<'x' | 'y'>): string | undefined {
    const sets = (code.ruleSets ?? []).map(rs => {
        const parts = rs.rules.map(r => {
            const axis = r.fragment !== undefined && r.fragment !== null ? axes[r.fragment] : undefined;
            const nums = values(r).map(numeral);
            const ops = r.method === 'NUMERIC_MATCH' ? ['=='] : COMPARE[r.method];
            if (!axis || !ops || !ops.every((_, k) => nums[k] !== undefined)) {
                notes.push(`Punktregel ${r.method} → Kodierende`);
                return `manual(${str(`${r.method} ${values(r).join(' | ')}`)})`;
            }
            return ops.map((op, k) => `${expr}.${axis} ${op} ${nums[k]}`).join(' and ');
        });
        return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : parts.map(p => `(${p})`).join(rs.ruleOperatorAnd ? ' and ' : ' or ');
    }).filter((x): x is string => x !== undefined);
    if (sets.length === 0) return undefined;
    return sets.length === 1 ? sets[0] : sets.map(x => `(${x})`).join(code.ruleSetOperatorAnd ? ' and ' : ' or ');
}

/** Codes assigned by rules (all except residual codes). */
function creditCodes(codes: CodingCode[]): CodingCode[] {
    return codes.filter(c => (c.type === undefined || CREDIT.has(c.type)) && (c.ruleSets ?? []).length > 0 &&
        c.id !== null && Number.isInteger(Number(c.id)));
}

function instruction(c?: CodingCode): string {
    return c?.manualInstruction ? shorten(plain(c.manualInstruction), 400) : '';
}

interface Case { id: number; label?: string; score: number; when: string }

/**
 * Cases of `codes(…)` from the automatic conditions of the credit codes. With a RESIDUAL code, AF asks the human
 * coder only if no code matches automatically. `conditions`: code → condition (for derived variables).
 */
function codeCases(codes: CodingCode[], credit: CodingCode[], autos: string[]): { cases: Case[]; conditions: Map<number, string> } {
    const manual = codes.find(c => c.type === 'RESIDUAL');
    const auto = codes.find(c => c.type === 'RESIDUAL_AUTO');
    const anyAuto = autos.length === 1 ? autos[0] : autos.map(a => `(${a})`).join(' or ');
    const cases: Case[] = credit.map((c, k) => {
        let when = autos[k];
        if (manual) {
            // The residual code's instruction ("all other responses") is no use as a question about this code
            const what = instruction(c) || (c.label ? plain(c.label) : '');
            const question = what ? `Code ${Number(c.id)}: ${what}` : `Code ${Number(c.id)}`;
            const ask = credit.length === 1 || anyAuto === 'false' ? `manual(${str(question)})` : `(not (${anyAuto}) and manual(${str(question)}))`;
            // no automatic condition (e.g. a drawing): only the human coder decides
            when = when === 'false' ? ask : `${when} or ${ask}`;
        }
        return { id: Number(c.id), ...(c.label ? { label: plain(c.label) } : {}), score: c.score ?? 0, when };
    });
    const conditions = new Map(cases.map(c => [c.id, c.when]));
    conditions.set(Number((manual ?? auto)?.id ?? 0), cases.length > 0 ? `not (${cases.map(c => c.when).join(' or ')})` : 'true');
    if (credit.length === 0 && manual) cases.push({ id: 1, score: 1, when: `manual(${str(instruction(manual) || 'Antwort beurteilen')})` });
    if (auto && Number(auto.id) !== 0) cases.push({ id: Number(auto.id), score: auto.score ?? 0, when: 'true' });
    return { cases, conditions };
}

/** Rule as lines in the `coding` block; a single code 1 with score 1 becomes `correct(…)`. */
function renderRule(name: string, cases: Case[]): string[] {
    const [first] = cases;
    if (cases.length === 1 && first.id === 1 && first.score === 1 && !first.label) return [`  ${name}: correct(${first.when})`];
    return [`  ${name}: codes(`, ...cases.map((c, i) =>
        `    code(${c.id}${c.label ? `, ${str(c.label)}` : ''}, score: ${c.score}, when: ${c.when})${i < cases.length - 1 ? ',' : ''}`), '  )'];
}

/** Converts the coding scheme; returns lines for `coding` and appends report entries to ctx.report. */
export function convertCoding(ctx: Context): string[] {
    const codings = ctx.unit.scheme?.variableCodings ?? [];
    const lines: string[] = [];
    const conditions = new Map<string, Map<number, string>>();   // IQB variable ID → code → condition (for derived variables)
    const report = (vc: VariableCoding, fidelity: 'kept' | 'approximated' | 'missing', note?: string) =>
        ctx.report.push({ element: vc.alias ?? vc.id, type: 'coding', fidelity, ...(note ? { note } : {}) });
    for (const vc of codings) {
        if (vc.sourceType !== 'BASE') continue;
        const answer = ctx.answers.get(vc.id);
        const codes = vc.codes ?? [];
        if (!answer || codes.length === 0) {
            if (codes.some(c => (c.ruleSets ?? []).length > 0)) report(vc, 'missing', 'Variable ohne AF-Antwort');
            continue;
        }
        const notes: string[] = [];
        const credit = creditCodes(codes);
        // Formula field: if several codes share a proportion (one code per spelling), keep comparing spellings;
        // otherwise any equivalent proportion counts
        const shares = credit.map(exactShare);
        const bySpelling = answer.kind === 'text' && answer.math && shares.some((s, i) => s !== undefined && shares.indexOf(s) !== i);
        const asked: Answer = answer.kind === 'text' && answer.math ? { ...answer, math: !bySpelling } : answer;
        const autos = credit.map(c => translateCode(c, asked, vc.processing ?? [], notes, vc.fragmenting) ?? 'false');
        const { cases, conditions: byCode } = codeCases(codes, credit, autos);
        conditions.set(vc.id, byCode);
        if (cases.length === 0) continue;
        // Rule name: the response name, or the row alias for matrix rows
        const name = answer.kind === 'row' || answer.kind === 'point' ? ctx.names.take(vc.alias ?? vc.id) : answer.name;
        ctx.rules.set(vc.id, name);
        lines.push(...renderRule(name, cases));
        report(vc, notes.every(n => n === NUMBER_NOTE) ? 'kept' : 'approximated', [...new Set(notes)].join('; '));
    }
    // Derived variables in scheme order (sources may themselves be derived)
    const idOf = (src: string) => conditions.has(src) || ctx.rules.has(src) ? src : codings.find(c => c.alias === src)?.id ?? src;
    for (const vc of codings) {
        if (vc.sourceType === 'BASE' || vc.sourceType === 'BASE_NO_VALUE') continue;
        const ids = (vc.deriveSources ?? []).map(idOf);
        if (ids.length === 0) { report(vc, 'missing', `${vc.sourceType} ohne Quellen`); continue; }
        if (vc.sourceType === 'SUM_SCORE' && ids.every(id => ctx.rules.has(id))) {
            const name = ctx.names.take(vc.alias ?? vc.id);
            ctx.rules.set(vc.id, name);
            lines.push(`  ${name}: sum_score(${ids.map(id => ctx.rules.get(id)).join(', ')})`);
            report(vc, 'kept');
            continue;
        }
        if ((vc.sourceType === 'SUM_CODE' || vc.sourceType === 'CONCAT_CODE') && ids.every(id => conditions.has(id))) {
            const codes = vc.codes ?? [];
            const credit = creditCodes(codes);
            const autos = credit.length > 0 ? derivedConditions(vc, credit, ids.map(id => conditions.get(id)!)) : undefined;
            if (autos) {
                const { cases, conditions: byCode } = codeCases(codes, credit, autos);
                conditions.set(vc.id, byCode);
                const name = ctx.names.take(vc.alias ?? vc.id);
                ctx.rules.set(vc.id, name);
                lines.push(...renderRule(name, cases));
                report(vc, 'kept', `${vc.sourceType}: Kombinationen der Codes aufgezählt`);
                continue;
            }
        }
        report(vc, 'missing', `${vc.sourceType} nicht übersetzt`);
    }
    return lines;
}

/** Whether a derived variable's code holds for this value; undefined for rule kinds not handled here. */
function holds(code: CodingCode, value: string | number): boolean | undefined {
    const n = Number(value);
    const results = (code.ruleSets ?? []).map(rs => {
        const r = rs.rules.map(rule => {
            const params = values(rule);
            const nums = params.map(p => Number(numeral(p) ?? NaN));
            const ops = COMPARE[rule.method];
            if (ops) return ops.every((op, k) => op === '>=' ? n >= nums[k] : op === '<=' ? n <= nums[k] : op === '>' ? n > nums[k] : n < nums[k]);
            if (rule.method === 'MATCH') return params.includes(String(value));
            if (rule.method === 'NUMERIC_MATCH') return nums.includes(n);
            return undefined;
        });
        if (r.includes(undefined)) return undefined;
        return rs.ruleOperatorAnd ? r.every(Boolean) : r.some(Boolean);
    });
    if (results.includes(undefined)) return undefined;
    return code.ruleSetOperatorAnd ? results.every(Boolean) : results.some(Boolean);
}

/**
 * Conditions of a derived variable's credit codes over its sources' responses: every combination of source codes
 * whose value (as in @iqb/responses: sum or "a_b") the code accepts. Undefined if not enumerable.
 */
function derivedConditions(vc: VariableCoding, credit: CodingCode[], sources: Map<number, string>[]): string[] | undefined {
    const combos = sources.reduce<number[][]>((acc, m) => acc.flatMap(c => [...m.keys()].map(k => [...c, k])), [[]]);
    if (combos.length > 64) return undefined;
    const value = (codes: number[]) => vc.sourceType === 'SUM_CODE' ? codes.reduce((a, b) => a + b, 0) : codes.join('_');
    const autos: string[] = [];
    for (const c of credit) {
        const hits: string[] = [];
        for (const combo of combos) {
            const ok = holds(c, value(combo));
            if (ok === undefined) return undefined;
            if (ok) hits.push(combo.map((code, i) => `(${sources[i].get(code)})`).join(' and '));
        }
        autos.push(hits.length > 0 ? hits.map(h => `(${h})`).join(' or ') : 'false');
    }
    return autos;
}
