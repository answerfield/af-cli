// Optional packages: the CLI works without them and reports a missing one when the command needs it.

import type { Bundle } from '@answerfield/bundle';

export type OptionalPackage = '@answerfield/import-iqb' | '@answerfield/export-typst';

/** What `af import iqb` uses from `@answerfield/import-iqb`. */
export interface IqbImport {
    importFolder(paths: string[], target: string, out: { log(line: string): void; error(line: string): void }): { exitCode: number; itemFiles: string[] };
}

/** Printable result of `exportTypst`. */
export interface TypstOutput {
    source: string;
    notes: string[];
}

/** Brand read from a `brand.json` folder. */
export interface TypstBrand {
    name: string;
    logo?: { name: string; data: Uint8Array };
    header?: string[];
    footer?: string;
    cover?: { fields?: string[] };
}

/** What `af pdf` uses from `@answerfield/export-typst`. */
export interface TypstExport {
    exportTypst(bundle: Bundle, name?: string, options?: { accommodations?: string[]; edition?: string; brand?: TypstBrand }): TypstOutput;
    renderPdf(output: TypstOutput, readAsset: (path: string) => Uint8Array | undefined): Promise<Uint8Array>;
}

/**
 * Loads an optional package; `undefined` if exactly this package is not installed. Other errors (a missing dependency
 * or file inside the package, a missing native binary) are rethrown. The specifier is a variable so `tsc` does not need
 * the package. `load` is replaceable for tests.
 */
export async function loadOptional<T>(name: OptionalPackage, load: (specifier: string) => Promise<unknown> = specifier => import(specifier)): Promise<T | undefined> {
    try {
        return await load(name) as T;
    } catch (e) {
        const error = e as { code?: string; message?: string };
        // Node names the missing specifier first ("Cannot find package 'x' imported from <importer>"); the importer path may contain our name too
        const missing = /^Cannot find (?:package|module) '([^']+)'/.exec(error.message ?? '')?.[1];
        if (error.code === 'ERR_MODULE_NOT_FOUND' && missing === name) return undefined;
        throw e;
    }
}
