// Helpers for writing AF source text: string literals, names.

/** Text as an AF string literal: only `\"` and `\\` are escapes; line breaks and non-breaking spaces become spaces. */
export function str(text: string): string {
    // Braces that would read as a placeholder ({name}, {{, }}) are doubled: they stay text
    return verbatim(text.replace(/\{\{|\}\}|\{(?=\s*[A-Za-z_][\w.]*\s*\})|(?<=\{\s*[A-Za-z_][\w.]*\s*)\}/g, b => b + b));
}

/** Text for math, accept, accepted and manual, whose braces are never placeholders (LaTeX, patterns, criteria). */
export function verbatim(text: string): string {
    const clean = text.replace(/ /g, ' ').replace(/[\r\n\t]+/g, ' ');
    // Double a backslash only where it would otherwise start an escape (before " or \ and at the end), so LaTeX stays readable
    return `"${clean.replace(/\\(?=["\\]|$)/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const KEYWORDS = new Set(['and', 'booklet', 'builtin', 'children', 'coding', 'component', 'element', 'else', 'enum',
    'events', 'false', 'fn', 'for', 'if', 'in', 'item', 'let', 'none', 'not', 'on', 'or', 'response', 'state', 'then', 'true']);

/** Assigns unique AF names from IQB aliases ("01a" → `a01a`, "text-field_1" → `text_field_1`). */
export class Names {
    private readonly used = new Set<string>();

    constructor(reserved: Iterable<string> = []) {
        for (const r of reserved) this.used.add(r);
    }

    take(alias: string, fallback = 'antwort'): string {
        let base = String(alias ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '').toLowerCase();
        if (base === '') base = fallback;
        if (/^\d/.test(base)) base = `a${base}`;
        if (KEYWORDS.has(base)) base = `${base}_`;
        let name = base;
        for (let i = 2; this.used.has(name); i++) name = `${base}_${i}`;
        this.used.add(name);
        return name;
    }
}

/** Option number (1-based) from an IQB value, else undefined. */
export function option(x: unknown): number | undefined {
    const n = Number(x);
    return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Shortens a text to label length, breaking at a word. */
export function shorten(text: string, max = 100): string {
    return text.length <= max ? text : `${text.slice(0, max - 1).replace(/\s+\S*$/, '')} …`;
}
