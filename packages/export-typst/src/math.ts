// LaTeX (as in `math("…")`) → Typst math. Covers only what items use; anything unknown yields undefined, and the
// export then prints the LaTeX text verbatim (and reports it).

const SYMBOLS: Record<string, string> = {
    cdot: 'dot.op', times: 'times', div: 'div', pm: 'plus.minus', mp: 'minus.plus', neq: '!=', ne: '!=', leq: '<=',
    le: '<=', geq: '>=', ge: '>=', approx: 'approx', mid: 'bar.v', circ: 'degree', degree: 'degree', infty: 'infinity',
    to: 'arrow.r', rightarrow: 'arrow.r', Rightarrow: 'arrow.r.double', angle: 'angle', perp: 'perp',
    parallel: 'parallel', triangle: 'triangle', percent: '%', ldots: 'dots.h', dots: 'dots.h', cdots: 'dots.c',
    lbrace: 'brace.l', rbrace: 'brace.r'
};
const GREEK = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa',
    'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
    'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Phi', 'Psi', 'Omega']);
/** Spacing commands: \, \: \; \quad … */
const SPACES: Record<string, string> = { ',': 'thin', ':': 'med', ';': 'thick', ' ': 'space', quad: 'quad', qquad: 'wide', '!': '' };

/** Text inside Typst math as a string literal ("km"). */
const quoted = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

class Parser {
    private i = 0;
    constructor(private readonly s: string) { }

    /** Sequence up to the end or the next `}`. */
    sequence(): string[] | undefined {
        const out: string[] = [];
        while (this.i < this.s.length && this.s[this.i] !== '}') {
            const atom = this.atom();
            if (atom === undefined) return undefined;
            if (atom !== '') out.push(atom);
        }
        return out;
    }

    /** One argument: {…} or a single character or command. */
    private argument(): string | undefined {
        this.skipSpace();
        if (this.s[this.i] === '{') {
            this.i++;
            const inner = this.sequence();
            if (inner === undefined || this.s[this.i] !== '}') return undefined;
            this.i++;
            return inner.join(' ');
        }
        return this.atom();
    }

    /** Raw text of a {…} argument (for \text). */
    private raw(): string | undefined {
        this.skipSpace();
        if (this.s[this.i] !== '{') return undefined;
        let depth = 0, start = ++this.i;
        for (; this.i < this.s.length; this.i++) {
            if (this.s[this.i] === '{') depth++;
            else if (this.s[this.i] === '}' && depth-- === 0) return this.s.slice(start, this.i++);
        }
        return undefined;
    }

    private skipSpace(): void {
        while (this.s[this.i] === ' ') this.i++;
    }

    private atom(): string | undefined {
        const c = this.s[this.i];
        if (c === ' ') { this.i++; return ''; }
        if (c === '{') {
            this.i++;
            const inner = this.sequence();
            if (inner === undefined || this.s[this.i] !== '}') return undefined;
            this.i++;
            // {,} is the decimal comma without spacing
            return inner.length === 1 && inner[0] === ',' ? '","' : `(${inner.join(' ')})`;
        }
        if (c === '^' || c === '_') {
            this.i++;
            const arg = this.argument();
            // 30^\circ is the degree sign, not an exponent
            if (c === '^' && arg === 'degree') return '"°"';
            return arg === undefined ? undefined : `${c}(${arg})`;
        }
        if (c === '\\') {
            this.i++;
            const name = /^[a-zA-Z]+/.exec(this.s.slice(this.i))?.[0] ?? this.s[this.i++];
            if (/^[a-zA-Z]/.test(name)) this.i += name.length;
            if (name in SPACES) return SPACES[name];
            if (name === '%' || name === '{' || name === '}' || name === '#' || name === '$' || name === '&' || name === '_') return quoted(name);
            if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
                const a = this.argument(), b = this.argument();
                return a === undefined || b === undefined ? undefined : `frac(${a}, ${b})`;
            }
            if (name === 'sqrt') {
                const a = this.argument();
                return a === undefined ? undefined : `sqrt(${a})`;
            }
            if (name === 'overline') {
                const a = this.argument();
                return a === undefined ? undefined : `overline(${a})`;
            }
            if (name === 'text' || name === 'mathrm' || name === 'textrm') {
                const t = this.raw();
                return t === undefined ? undefined : `upright(${quoted(t)})`;
            }
            if (name === 'left' || name === 'right') return '';
            if (GREEK.has(name)) return name.replace(/^var/, '') === name ? name : `${name.slice(3)}.alt`;
            return SYMBOLS[name];
        }
        this.i++;
        // Letters one by one (letter runs are identifiers in Typst); digits and symbols as they are
        if (/[a-zA-Z]/.test(c)) return c;
        if (/[0-9.]/.test(c)) return c;
        if (c === ',') return ',';
        if ('+-=<>()[]|:/!?\'*'.includes(c)) return c === '*' ? '*' : c === '/' ? '\\/' : c;
        if (c === '%') return quoted('%');
        if (c === '#' || c === '$' || c === '"' || c === '@') return quoted(c);
        // Keep Unicode (−, ·, °, …) as is
        return quoted(c);
    }

    get done(): boolean {
        return this.i >= this.s.length;
    }
}

/** LaTeX → content of a Typst equation (without `$`); undefined for unsupported commands. */
export function texToTypst(tex: string): string | undefined {
    const parser = new Parser(tex.trim());
    const parts = parser.sequence();
    if (parts === undefined || !parser.done) return undefined;
    // Keep digit runs together ("1500", not "1 5 0 0") and attach super-/subscripts to the preceding part;
    // otherwise separate parts with spaces
    const tight = (p: string, i: number) => i === 0 || /^[\^_)\]]/.test(p) || /[([]$/.test(parts[i - 1]) ||
        p === '","' || parts[i - 1] === '","' || p === '"°"' ||
        (/^[0-9.]$/.test(p) && /[0-9.]$/.test(parts[i - 1]));
    return parts.reduce((acc, p, i) => acc + (tight(p, i) ? '' : ' ') + p, '');
}
