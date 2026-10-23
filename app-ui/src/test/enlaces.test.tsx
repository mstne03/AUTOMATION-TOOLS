import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
import { invoke } from "@tauri-apps/api/core";
import { EnlaceExterno, esUrlHttps } from "../enlaces";

describe("EnlaceExterno", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("solo acepta https sin espacios", () => {
    expect(esUrlHttps("https://youtu.be/abc")).toBe(true);
    for (const mala of ["http://x.com", "javascript:alert(1)", "file:///C:/x", "https://a b"]) expect(esUrlHttps(mala)).toBe(false);
  });

  it("fuera de Tauri es un enlace normal y no llama a Rust", () => {
    render(<EnlaceExterno href="https://youtu.be/abc">v</EnlaceExterno>);
    fireEvent.click(screen.getByText("v"));
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByText("v").getAttribute("target")).toBe("_blank");
  });

  it("en Tauri intercepta el clic y llama a abrir_url", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    render(<EnlaceExterno href="https://youtu.be/abc">v</EnlaceExterno>);
    fireEvent.click(screen.getByText("v"));
    expect(invoke).toHaveBeenCalledWith("abrir_url", { url: "https://youtu.be/abc" });
  });

  it("un esquema que no es https se pinta como texto, sin enlace", () => {
    const { container } = render(<EnlaceExterno href="javascript:alert(1)">x</EnlaceExterno>);
    expect(container.querySelector("a")).toBeNull();
  });
});
