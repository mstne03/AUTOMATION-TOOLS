import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "../chat/Markdown";

describe("Markdown", () => {
  it("párrafos, listas, negrita, código y enlaces, sin HTML crudo", () => {
    const texto =
      "He subido el vídeo.\n\n- **ID:** abc\n- URL: https://youtu.be/abc\n\nUsa `youtube_delete_video`.\n\n<img src=x onerror=alert(1)>";
    const { container } = render(<Markdown text={texto} />);
    expect(container.querySelectorAll("p")).toHaveLength(3);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("strong")?.textContent).toBe("ID:");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://youtu.be/abc");
    expect(container.querySelector("a")?.getAttribute("rel")).toContain("noopener");
    expect(container.querySelector("code")?.textContent).toBe("youtube_delete_video");
    expect(container.querySelector("img")).toBeNull(); // el HTML del modelo se muestra como texto
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  // Salida con la forma de los análisis de canal reales: cabecera, tabla y fuentes.
  const ANALISIS = [
    "## Recomendaciones",
    "",
    "| Acción | Impacto |",
    "| :-- | --: |",
    "| Gancho en los 2 primeros segundos | **Alto** |",
    "| Miniatura | Medio |",
    "",
    "### Fuentes",
    "1. https://support.google.com/youtube y https://support.google.com/youtube.",
    "2. [TikTok](https://www.tiktok.com/creators)",
  ].join("\n");

  it("cabeceras y tablas se pintan como elementos, no en crudo", () => {
    const { container } = render(<Markdown text={ANALISIS} />);
    expect(container.querySelector("h3")?.textContent).toBe("Recomendaciones");
    expect(container.querySelector("h4")?.textContent).toBe("Fuentes");
    expect(Array.from(container.querySelectorAll("th")).map((t) => t.textContent)).toEqual(["Acción", "Impacto"]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelector("tbody td strong")?.textContent).toBe("Alto");
    expect(container.querySelectorAll("tbody tr")[0].querySelectorAll("td")[1].getAttribute("data-align")).toBe("right");
    expect(container.textContent).not.toContain("##");
    expect(container.textContent).not.toContain("| ---");
  });

  it("la misma URL lleva el mismo número, sin arrastrar el punto final, y [texto](url) conserva su texto", () => {
    const { container } = render(<Markdown text={ANALISIS} />);
    const enlaces = Array.from(container.querySelectorAll("a"));
    expect(enlaces.map((a) => a.textContent)).toEqual(["1 · support.google.com ↗", "1 · support.google.com ↗", "TikTok"]);
    expect(enlaces[1].getAttribute("href")).toBe("https://support.google.com/youtube");
  });

  it("citas y bloques de código; el código no interpreta Markdown ni HTML", () => {
    const { container } = render(<Markdown text={"> dato clave\n\n```html\n<b>**no**</b>\n```\n\nfin"} />);
    expect(container.querySelector("blockquote")?.textContent).toBe("dato clave");
    expect(container.querySelector("pre code")?.textContent).toBe("<b>**no**</b>");
    expect(container.querySelector("pre b")).toBeNull();
    expect(container.querySelector("pre strong")).toBeNull();
  });

  it("un bloque de código sin cerrar no se traga el resto ni rompe el render", () => {
    const { container } = render(<Markdown text={"antes\n\n```\ncódigo sin cerrar"} />);
    expect(container.querySelector("pre code")?.textContent).toBe("código sin cerrar");
    expect(container.querySelector("p")?.textContent).toBe("antes");
  });

  it("solo se enlazan URLs https: http y otros esquemas salen como texto", () => {
    const { container } = render(<Markdown text={"http://inseguro.com y [x](javascript:alert(1)) y https://ok.com"} />);
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["https://ok.com"]);
    expect(container.textContent).toContain("http://inseguro.com");
  });
});
