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

                // The UI lives in ui/app/, reached through the src/app dev
                // symlink. Rollup resolves that to its real path, so bare
                // imports from inside it are looked up by walking UP FROM
                // ui/app — which never reaches decky_plugin/node_modules, and
                // react-icons then falls through as an unresolved external:
                // the plugin builds clean and ships with no icons. Pin them.
                // (desktop/vite.config.ts pins the same packages, for the
                // mirror-image reason.)
                { find: /^react-icons\//, replacement: resolve(import.meta.dirname, "node_modules/react-icons") + "/" },
                { find: /^pdfjs-dist(\/.*)?$/, replacement: resolve(import.meta.dirname, "node_modules/pdfjs-dist") + "$1" },
            ],
        }),
    ],
    // Decky loads dist/index.js alone, so everything must live in it: the PDF
    // reader's lazily imported pdf.js would otherwise be split into chunk
    // files next to it that nothing is known to serve.
    output: {
        inlineDynamicImports: true,
    },
});
