// tokens/tokens.json -> src/styles/tokens.css (Style Dictionary). `pnpm tokens`.
// Los tokens con grupo `dark` / `light` (color, elevation) son los que cambian con el tema:
//   :root                          -> oscuro (valor por defecto)
//   @media (prefers-color-scheme: light) :root:not([data-theme]) -> claro cuando el sistema lo pide
//   :root[data-theme="dark|light"] -> preferencia explícita (la pone AppShell, DS-04)
// El resto de tokens es común. El CSS generado se commitea: CI no necesita este paso.
import StyleDictionary from "style-dictionary";

const TEMAS = ["dark", "light"];

StyleDictionary.registerFormat({
  name: "seo/css-temas",
  format: ({ dictionary }) => {
    const comunes = [];
    const porTema = { dark: [], light: [] };
    for (const t of dictionary.allTokens) {
      const [grupo, tema, ...resto] = t.path;
      if (TEMAS.includes(tema)) porTema[tema].push(`--${[grupo, ...resto].join("-")}: ${t.$value};`);
      else comunes.push(`--${t.path.join("-")}: ${t.$value};`);
    }
    const bloque = (sel, decls, sangria = "") =>
      `${sangria}${sel} {\n${decls.map((d) => `${sangria}  ${d}`).join("\n")}\n${sangria}}\n`;
    return (
      "/* Generado por tokens/build.mjs desde tokens/tokens.json. No editar a mano: `pnpm tokens`. */\n" +
      bloque(":root", [...comunes, "color-scheme: dark;", ...porTema.dark]) +
      "\n@media (prefers-color-scheme: light) {\n" +
      bloque(":root:not([data-theme])", ["color-scheme: light;", ...porTema.light], "  ") +
      "}\n\n" +
      bloque(':root[data-theme="dark"]', ["color-scheme: dark;", ...porTema.dark]) +
      "\n" +
      bloque(':root[data-theme="light"]', ["color-scheme: light;", ...porTema.light])
    );
  },
});

const sd = new StyleDictionary({
  source: ["tokens/tokens.json"],
  platforms: {
    css: {
      buildPath: "src/styles/",
      files: [{ destination: "tokens.css", format: "seo/css-temas" }],
    },
  },
  log: { verbosity: "silent" },
});
await sd.buildAllPlatforms();
