import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("avisa de la versión y solo instala tras confirmar en el diálogo", async () => {
    vi.mocked(checkForUpdate).mockResolvedValueOnce({ version: "0.2.0", notes: "Arreglos" });
    vi.mocked(installUpdate).mockResolvedValue();
    render(<UpdateBanner />);
    const banner = await screen.findByTestId("update-banner");
    expect(banner.textContent).toContain("0.2.0");
    expect(banner.textContent).toContain("Arreglos");

    fireEvent.click(screen.getByRole("button", { name: "Instalar y reiniciar" }));
    const dialogo = await screen.findByRole("dialog", { name: /Instalar SEO Studio 0.2.0/ });
    fireEvent.click(within(dialogo).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(installUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Instalar y reiniciar" }));
    const otra = await screen.findByRole("dialog");
    fireEvent.click(within(otra).getByRole("button", { name: "Instalar y reiniciar" }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(banner.textContent).toContain("Descargando e instalando"));
  });
});
