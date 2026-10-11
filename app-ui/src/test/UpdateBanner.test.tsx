import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../updater", () => ({ checkForUpdate: vi.fn(), installUpdate: vi.fn() }));
import { UpdateBanner } from "../UpdateBanner";
import { checkForUpdate, installUpdate } from "../updater";

describe("UpdateBanner", () => {
  afterEach(() => vi.restoreAllMocks());

  it("no pinta nada si no hay actualización o la comprobación falla", async () => {
    vi.mocked(checkForUpdate).mockResolvedValueOnce(null);
    const { container, unmount } = render(<UpdateBanner />);
    await waitFor(() => expect(checkForUpdate).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
    unmount();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(checkForUpdate).mockRejectedValueOnce(new Error("sin red"));
    const r2 = render(<UpdateBanner />);
    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(r2.container.innerHTML).toBe("");
  });

  it("avisa de la versión y solo instala tras confirmar", async () => {
    vi.mocked(checkForUpdate).mockResolvedValueOnce({ version: "0.2.0", notes: "Arreglos" });
    vi.mocked(installUpdate).mockResolvedValue();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<UpdateBanner />);
    const banner = await screen.findByTestId("update-banner");
    expect(banner.textContent).toContain("0.2.0");
    expect(banner.textContent).toContain("Arreglos");
    const boton = screen.getByRole("button", { name: "Instalar y reiniciar" });
    boton.click();
    expect(installUpdate).not.toHaveBeenCalled();
    boton.click();
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(banner.textContent).toContain("Descargando e instalando");
  });
});
