import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { exportTypst, renderPdf, texToTypst } from '../src/index.js';
import { workspace } from './workspace.js';

describe('Formeln', () => {
    test('LaTeX aus Aufgaben → Typst', () => {
        expect(texToTypst('\\frac{3}{4}')).toBe('frac(3, 4)');
        expect(texToTypst('4 \\cdot (2 + 1) = 12')).toBe('4 dot.op (2 + 1) = 12');
        expect(texToTypst('1500\\,\\text{m}^2')).toBe('1500 thin upright("m")^(2)');
        expect(texToTypst('-2{,}5 +')).toBe('- 2","5 +');
        expect(texToTypst('\\overline{AB}')).toBe('overline(A B)');
        expect(texToTypst('\\alpha = 30^\\circ')).toBe('alpha = 30"°"');
        expect(texToTypst('25\\,\\frac{\\text{m}}{\\text{s}}')).toBe('25 thin frac(upright("m"), upright("s"))');
        expect(texToTypst('\\unbekannt{x}')).toBeUndefined();
    });
});

describe('Druckfassung', () => {
    const source = `item pr1 "Druck" {
  stimulus {
    p "Ein langer Text."
    variant(easy_language) { p "Kurz." p "Noch kurz." }
  }
  p { "Kürze 6/8: " g = Gap("gekürzt", width: 4em) }
  c = Choice(wording("Welcher Bruch ist größer?", easy: "Was ist mehr?"), ["2/5", "3/5"])
  t = FreeText("Begründe.", max: 300)
  m = MarkWords("Der Hund bellt", label: "Unterstreiche das Verb.")
  p { "Formel: " math("\\\\frac{1}{2}") }
  show(when: c == {2}) { w = FreeText("Warum?") }
}
booklet prh "Heft" {
  part("Teil A") { pr1 }
  part("Teil B") { pr1 }
}
`;
    async function bundle() {
        const { compile } = await workspace({ pr1: source });
        return compile('pr1').bundle;
    }

    test('Bausteine in Papierform, Sprachstufen wie digital', async () => {
        const b = await bundle();
        const plain = exportTypst(b, 'pr1').source;
        expect(plain).toContain('#text(weight: "bold", size: 1.1em)[Aufgabe 1: Druck]');
        expect(plain).toContain('Kürze 6\\/8: #af-gap(4em)');
        expect(plain).toContain('#af-option[2\\/5]');
        expect(plain).toContain('Welcher Bruch ist größer?');
        expect(plain).toContain('#af-lines(5)');
        expect(plain).toContain('Der Hund bellt');
        expect(plain).toContain('$frac(1, 2)$');
        expect(plain).toContain('Ein langer Text.');
        // Follow-up question (shown digitally only after a response): printed and marked
        expect(plain).toContain('dash: "dashed")))[Warum?');
        const easy = exportTypst(b, 'pr1', { accommodations: ['easy_language'] }).source;
        expect(easy).toContain('Was ist mehr?');
        expect(easy).toContain('Noch kurz.');
        expect(easy).not.toContain('Ein langer Text.');
        // One sentence per line: inner paragraphs stand alone (a paragraph inside a paragraph would render empty)
        expect(easy).not.toMatch(/#par\[#par\[/);
        expect(easy).toContain('#par[Noch kurz.]');
    });

    test('Testheft: Teile auf linker Seite, STOPP am Ende jedes Teils', async () => {
        const t = exportTypst(await bundle(), 'prh').source;
        expect(t.match(/#af-stop/g)).toHaveLength(2);
        expect(t).toContain('#pagebreak(to: "even", weak: true)');
        expect(t).toContain('[Aufgabe 2: Druck]');
    });

    test('PDF: gleiche Eingabe ergibt dieselben Bytes', async () => {
        const out = exportTypst(await bundle(), 'prh');
        const a = await renderPdf(out, () => undefined);
        const b = await renderPdf(out, () => undefined);
        expect(Buffer.from(a.slice(0, 5)).toString()).toBe('%PDF-');
        expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    }, 60000);

    test('Marke: Kopf mit Logo, Fuß mit Fassung und Anpassungen, Deckblatt mit Feldern', async () => {
        const logo = { name: 'logo.svg', data: readFileSync(join(__dirname, 'fixtures/logo.svg')) };
        const out = exportTypst(await bundle(), 'prh', {
            accommodations: ['easy_language'], edition: 'abcd1234',
            brand: { name: 'Beispielland', logo, header: ['Beispielbehörde', 'Lernstandserhebung'], footer: 'Nur für unsere Schulen', cover: { fields: ['Schule', 'Code'] } }
        });
        expect(out.files).toHaveProperty(['/brand/logo.svg']);
        expect(out.source).toContain('image("/brand/logo.svg", height: 1.2cm)');
        expect(out.source).toContain('Beispielbehörde \\ Lernstandserhebung');
        expect(out.source).toContain('Nur für unsere Schulen #h(1fr) Fassung abcd1234 · Leichte Sprache');
        expect(out.source).toContain('#page(header: none)');
        expect(out.source).toContain('[Schule:]');
        const pdf = await renderPdf(out, () => undefined);
        expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
        expect(() => exportTypst({ items: [] } as never, undefined, { brand: { name: 'x', logo: { name: '../a.svg', data: new Uint8Array() } } })).toThrow();
    }, 60000);
});
