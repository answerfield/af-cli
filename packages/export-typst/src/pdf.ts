// Native Typst compiler (@myriaddreamin/typst-ts-node-compiler) and font (Atkinson Hyperlegible, OFL), embedded
// instead of system fonts so the same booklet breaks lines identically everywhere.

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';
import type { TypstOutput } from './typst.js';

function fonts(): Buffer[] {
    const dir = dirname(createRequire(import.meta.url).resolve('@expo-google-fonts/atkinson-hyperlegible/package.json'));
    return readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.ttf')).sort().map(f => readFileSync(join(dir, f)));
}

let compiler: NodeCompiler | undefined;

/** Compiles Typst output to PDF; media are mapped into the compiler's virtual file system for this call only. */
export function compilePdf(output: TypstOutput, readAsset: (path: string) => Uint8Array | undefined): Uint8Array {
    compiler ??= NodeCompiler.create({ workspace: '/', fontArgs: [{ fontBlobs: fonts() }] });
    for (const path of output.assets) {
        const data = readAsset(path);
        if (!data) throw new Error(`Medium fehlt: ${path}`);
        compiler.mapShadow(`/assets/${path}`, Buffer.from(data));
    }
    for (const [path, data] of Object.entries(output.files ?? {})) compiler.mapShadow(path, Buffer.from(data));
    try {
        return compiler.pdf({ mainFileContent: output.source });
    } finally {
        for (const path of output.assets) compiler.unmapShadow(`/assets/${path}`);
        for (const path of Object.keys(output.files ?? {})) compiler.unmapShadow(path);
    }
}
