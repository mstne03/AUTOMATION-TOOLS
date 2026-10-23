import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, Dialog, Toaster, reiniciarToasts, toast } from "../ui";

afterEach(() => {
  cleanup();
  reiniciarToasts();
});

describe("Dialog y ConfirmDialog", () => {
  it("el diálogo tiene nombre accesible y Escape lo cierra", () => {
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange} title="Título" description="Texto" />);
    expect(screen.getByRole("dialog", { name: "Título" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("ConfirmDialog: cancelar no ejecuta nada y confirmar llama a onConfirm tras cerrar", async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} title="¿Borrar?" confirmLabel="Borrar" tone="danger" onConfirm={onConfirm} />);
    const d = screen.getByRole("dialog", { name: "¿Borrar?" });
    fireEvent.click(within(d).getByRole("button", { name: "Cancelar" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(within(d).getByRole("button", { name: "Borrar" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
  });
});

describe("toast()", () => {
  it("se anuncia con role=status y muestra título y descripción", async () => {
    render(<Toaster />);
    act(() => toast({ title: "Guardado", description: "Modelo guardado" }));
    // Radix anuncia el aviso en una región role="status" (con retardo) además de pintarlo
    await waitFor(() => {
      const hay = screen.getAllByRole("status").some((a) => a.textContent?.includes("Guardado") && a.textContent.includes("Modelo guardado"));
      expect(hay).toBe(true);
    });
  });
});
