// Translates a Testcenter booklet (<Booklet>) into an AF booklet: consecutive units form a part, each <Testlet> its
// own part; a testlet that asks for a release code (CodeToEnter) waits for the test administrator
// (`start: released`), a time limit (TimeMax) becomes `time:`.

import { str } from './text.js';

/** Result of translating one Testcenter booklet. */
export interface BookletResult {
    /** AF booklet name (from the booklet ID) */
    name: string;
    /** AF source of the booklet; empty if none of its units was imported */
    source: string;
    /** Unit IDs the booklet lists but that were not imported (left out of the booklet) */
    missing: string[];
}

/** Is this XML a Testcenter booklet (root element `<Booklet>`)? */
export function isBookletXml(xml: string): boolean {
    return /^﻿?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<Booklet[\s>]/.test(xml);
}

/** AF name from an ID: lower case, letters/digits/underscore, not starting with a digit. */
function nameOf(id: string): string {
    const base = id.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    return /^\d/.test(base) ? `b${base}` : base || 'testheft';
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const decode = (t: string) => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Translates a booklet. `items` maps unit IDs to the names of the imported items; units without an item are left out
 * and reported in `missing`.
 */
export function importBooklet(xml: string, items: ReadonlyMap<string, string>): BookletResult {
    const id = /<Id>([^<]*)<\/Id>/.exec(xml)?.[1]?.trim() ?? 'testheft';
    const label = decode(/<Label>([^<]*)<\/Label>/.exec(xml)?.[1]?.trim() ?? id);
    const body = /<Units>([\s\S]*)<\/Units>/.exec(xml)?.[1] ?? '';
    const missing: string[] = [];
    const parts: Array<{ title: string; released: boolean; seconds?: number; entries: string[] }> = [];
    let loose: string[] = [];
    const seen = new Set<string>();
    // The Testcenter compares IDs case-insensitively (booklet "ABwarte" → unit "ABWarte")
    const byId = new Map([...items].map(([k, v]) => [k.toUpperCase(), v]));
    const entry = (unitTag: string): string | undefined => {
        const unitId = attr(unitTag, 'id') ?? '';
        const item = byId.get(unitId.toUpperCase());
        if (!item) missing.push(unitId);
        // an AF booklet lists each item once
        if (!item || seen.has(item)) return undefined;
        seen.add(item);
        return item;
    };
    const flush = () => {
        if (loose.length > 0) parts.push({ title: parts.length === 0 ? label : 'Fortsetzung', released: false, entries: loose });
        loose = [];
    };
    // Units at the top level and testlets, in document order
    for (const m of body.matchAll(/<Testlet\b([^>]*)>([\s\S]*?)<\/Testlet>|<Unit\b[^>]*\/?>/g)) {
        if (m[0].startsWith('<Unit')) {
            const item = entry(m[0]);
            if (item) loose.push(item);
            continue;
        }
        flush();
        const [, tag, inner] = m;
        const time = /<TimeMax\b[^>]*\bminutes="(\d+)"/.exec(inner)?.[1];
        const entries = [...inner.matchAll(/<Unit\b[^>]*\/?>/g)].map(u => entry(u[0])).filter((e): e is string => e !== undefined);
        if (entries.length > 0) {
            parts.push({
                title: decode(attr(tag, 'label') ?? attr(tag, 'id') ?? 'Teil'), released: /<CodeToEnter\b/.test(inner),
                ...(time ? { seconds: Number(time) * 60 } : {}), entries
            });
        }
    }
    flush();
    const name = nameOf(id);
    const lines = [
        `// ${label} (importiert aus dem Testcenter-Testheft ${id})`,
        ...(missing.length > 0 ? [`// Nicht importiert und daher ausgelassen: ${missing.join(', ')}.`] : []),
        `booklet ${name} ${str(label)} {`,
        ...parts.flatMap(p => [
            `  part(${str(p.title)}${p.seconds ? `, time: ${p.seconds / 60}min` : ''}${p.released ? ', start: released' : ''}) {`,
            ...p.entries.map(e => `    ${e}`),
            '  }'
        ]),
        '}'
    ];
    return { name, source: parts.length > 0 ? lines.join('\n') + '\n' : '', missing };
}
