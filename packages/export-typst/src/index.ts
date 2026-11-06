// Print version as PDF: item or booklet → Typst → PDF. Optional and separate from the runtime (like the importer);
// used by `af pdf`. The native Typst compiler is loaded only when a PDF is actually rendered.

import type { Bundle } from '@answerfield/bundle';
import { createItemInstance, effectiveAccommodations, requestedAccommodations, type NeedsProfile } from '@answerfield/runtime-core';
import { ADAPTATION_NAMES, document, TypstWriter, type Brand, type PrintPart, type TypstOutput } from './typst.js';

export type { TypstOutput } from './typst.js';

/** Brand (see Brand) with the logo as a file (name with extension, e.g. logo.svg). */
export interface BrandInput extends Omit<Brand, 'logo'> {
    logo?: { name: string; data: Uint8Array };
}
export { texToTypst } from './math.js';

/** Options for `exportTypst`. */
export interface PrintOptions {
    /** Needs profile; applied as in the digital runtime (language levels, descriptions, magnification). */
    profile?: NeedsProfile;
    /** Accommodations requested directly (in addition to the profile), e.g. ["easy_language"]. */
    accommodations?: string[];
    /** Brand (white labeling): header with logo, footer, cover page. */
    brand?: BrandInput;
    /** Edition identifier, e.g. a prefix of the bundle checksum. */
    edition?: string;
}

/** Typst source for item or booklet `name` of the bundle (default: first booklet, else first item). */
export function exportTypst(bundle: Bundle, name?: string, options: PrintOptions = {}): TypstOutput {
    const requested = [...requestedAccommodations(options.profile ?? {}), ...(options.accommodations ?? [])];
    const booklet = bundle.booklets?.find(b => b.name === name) ?? (name ? undefined : bundle.booklets?.[0]);
    const item = (n: string, allowed: Iterable<string>) => {
        const def = bundle.items.find(i => i.name === n);
        if (!def) throw new Error(`Aufgabe '${n}' ist nicht im Bundle`);
        const instance = createItemInstance(bundle, n, { accommodations: allowed });
        return { def, instance };
    };
    const writer = new TypstWriter();
    let title: string, parts: PrintPart[], accommodations: ReadonlySet<string>;
    if (booklet) {
        accommodations = effectiveAccommodations(requested, booklet.accommodations);
        title = booklet.title ?? booklet.name;
        parts = booklet.parts.map(p => ({
            title: p.title ?? p.name,
            items: p.entries.map(e => {
                const { def, instance } = item(e, accommodations);
                return { title: def.title ?? '', nodes: instance.nodes, instruction: def.instruction };
            })
        }));
    } else {
        const def = bundle.items.find(i => i.name === name) ?? (name ? undefined : bundle.items[0]);
        if (!def) throw new Error(`'${name}' ist weder Aufgabe noch Testheft im Bundle`);
        const { instance } = item(def.name, requested);
        accommodations = instance.accommodations;
        title = def.title ?? def.name;
        parts = [{ items: [{ title: def.title ?? '', nodes: instance.nodes }] }];
    }
    const scale = accommodations.has('magnification') ? Math.max(1, options.profile?.display?.scale ?? 1.5) : 1;
    const adaptations = [...accommodations].sort().filter(a => ADAPTATION_NAMES[a]).map(a => ADAPTATION_NAMES[a]);
    const { logo, ...rest } = options.brand ?? { name: '' };
    const files: Record<string, Uint8Array> = {};
    if (logo) {
        if (!/^[\w.-]+\.(svg|png|jpe?g)$/i.test(logo.name)) throw new Error(`Logo als SVG, PNG oder JPEG mit einfachem Namen: ${logo.name}`);
        files[`/brand/${logo.name}`] = logo.data;
    }
    const brand: Brand | undefined = options.brand ? { ...rest, ...(logo ? { logo: `/brand/${logo.name}` } : {}) } : undefined;
    const source = document({ title, scale, brand, edition: options.edition, adaptations }, parts, writer);
    return { source, assets: [...writer.assets], files, notes: [...writer.notes] };
}

/** Renders the Typst source to PDF; `readAsset` supplies media by bundle path. Same input, same bytes. */
export async function renderPdf(output: TypstOutput, readAsset: (path: string) => Uint8Array | undefined): Promise<Uint8Array> {
    const { compilePdf } = await import('./pdf.js');
    return compilePdf(output, readAsset);
}
