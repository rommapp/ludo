import { resolve } from "path";
import alias from "@rollup/plugin-alias";
import deckyPlugin from "@decky/rollup";

// `@ludo/host` is how the shared UI names the shell it runs inside; here it
// resolves to the Decky adapter. The desktop build points the same specifier at
// its own adapter (see desktop/vite.config.ts), which is what lets
// src/index.tsx be consumed byte-identically by both without either shell
// impersonating the other. Both satisfy ui/host/contract.ts.
//
// deckyPlugin() merges via merge-anything's mergeAndConcat, so plugins passed
// here are concatenated ahead of its own — which is what alias needs, since it
// must rewrite the specifier before node-resolve tries to find a package.
export default deckyPlugin({
    plugins: [
        alias({
            entries: [
                { find: "@ludo/host", replacement: resolve(import.meta.dirname, "src/host/index.ts") },
            ],
        }),
    ],
});
