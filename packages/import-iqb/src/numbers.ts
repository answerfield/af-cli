// Readable codings for number fields: a gap whose response is only ever read as number(x) becomes a NumberGap, so the
// coding compares x itself; a lower and an upper bound become a range (x in a .. b). Works on AF source text, for the
// importer and for migrating imported files.

/** Tokens of AF source outside strings and comments, with their offsets. */
function identifiers(source: string): Array<{ name: string; at: number }> {
    const out: Array<{ name: string; at: number }> = [];
    const re = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_]\w*/g;
    for (let m = re.exec(source); m; m = re.exec(source)) {
        const t = m[0];
        if (t.startsWith('"') || t.startsWith('/')) continue;
        out.push({ name: t, at: m.index });
    }
    return out;
}

/** Rewrites number gaps and ranges; source without such gaps is returned unchanged. */
export function preferNumberGaps(source: string): string {
    const ids = identifiers(source);
    const gaps = new Set<string>();
    for (const m of source.matchAll(/\b([A-Za-z_]\w*) = Gap\(([^()]|\([^()]*\))*\)/g)) {
        // NumberGap takes no `initial` (a prefilled text to correct)
        if (!/\binitial:/.test(m[0])) gaps.add(m[1]);
    }
    const numeric = [...gaps].filter(name => {
        const uses = ids.filter(t => t.name === name);
        let reads = 0;
        for (const u of uses) {
            const before = source.slice(Math.max(0, u.at - 7), u.at);
            const after = source.slice(u.at + name.length, u.at + name.length + 3);
            if (after.startsWith(' = ')) continue;                                                                      // the binding
            if (/^\s*:/.test(after) && source.slice(u.at - 2, u.at).trim() === '') continue;                            // coding rule name
            if (before === 'number(' && after.startsWith(')')) { reads++; continue; }
            return false;
        }
        return reads > 0;
    });
    if (numeric.length === 0) return source;
    let out = source;
    for (const name of numeric) {
        out = out.replace(new RegExp(`\\b${name} = Gap\\(`, 'g'), `${name} = NumberGap(`)
            .replace(new RegExp(`\\bnumber\\(${name}\\)`, 'g'), name);
        // Both bounds inclusive: a range reads better
        out = out.replace(new RegExp(`\\b${name} >= ([^\\s(),]+) and ${name} <= ([^\\s(),]+)`, 'g'), `${name} in $1 .. $2`);
    }
    return out;
}
