import { registerHooks } from "node:module";
import { extname } from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Ejecuta el código TypeScript real con Node 24, resolviendo imports de Workers.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL?.includes("/src/") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts") && url.includes("/src/")) {
      const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
