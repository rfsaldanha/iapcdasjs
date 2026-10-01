import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const check = process.argv.includes("--check");
if (!check) await mkdir("public/js", { recursive: true });
const common = {
  entryPoints: ["src/index.js"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  charset: "utf8",
  legalComments: "none",
  write: false,
  banner: { js: "// Gerado por npm run build. Edite src/index.js." },
};
for (const options of [
  { format: "esm", outfile: "public/js/iapcdas.esm.js" },
  { format: "iife", globalName: "IAPCDAS", outfile: "public/js/iapcdas.js" },
]) {
  const result = await build({ ...common, ...options });
  for (const file of result.outputFiles) {
    if (check) {
      const current = await readFile(file.path).catch(() => null);
      if (!current || !current.equals(Buffer.from(file.contents))) {
        throw new Error(options.outfile + " está desatualizado. Execute npm run build.");
      }
    } else {
      await writeFile(file.path, file.contents);
    }
  }
}
if (check) console.log("Os arquivos distribuídos correspondem ao código-fonte.");
