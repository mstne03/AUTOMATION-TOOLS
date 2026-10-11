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
});
