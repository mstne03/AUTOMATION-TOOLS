import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Bell } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Chip, Field, IconButton, Input, SegmentedControl, TagInput } from "../ui";

afterEach(cleanup);

describe("Field", () => {
  it("el contador muestra n / max y se marca al pasarse", () => {
    const { rerender } = render(
      <Field label="Título" count={5} max={100}>
        <Input defaultValue="hola" />
      </Field>,
    );
    expect(screen.getByTestId("field-contador").textContent).toBe("5 / 100");
    expect(screen.getByLabelText("Título").getAttribute("aria-invalid")).toBeNull();

    rerender(
      <Field label="Título" count={101} max={100}>
        <Input defaultValue="hola" />
      </Field>,
    );
    expect(screen.getByLabelText("Título").getAttribute("aria-invalid")).toBe("true");
  });

  it("enlaza etiqueta, ayuda y error con el control", () => {
    render(
      <Field label="Descripción" help="Ayuda" error="Falta">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Descripción");
    const descritoPor = input.getAttribute("aria-describedby")!;
    expect(descritoPor.split(" ")).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toBe("Falta");
  });
});

describe("SegmentedControl", () => {
  function Demo({ onChange = () => {} }: { onChange?: (v: string) => void }) {
    const [v, setV] = useState("a");
    return (
      <SegmentedControl
        aria-label="Letra"
        value={v}
        onChange={(x) => {
          setV(x);
          onChange(x);
        }}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
          { value: "c", label: "C" },
        ]}
      />
    );
  }

  it("es un radiogroup con una sola parada de tabulador y flechas que seleccionan y envuelven", () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    expect(screen.getByRole("radiogroup", { name: "Letra" })).toBeTruthy();
    const [a, b, c] = screen.getAllByRole("radio");
    expect([a, b, c].map((r) => r.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);

    a.focus();
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(b.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(b);

    fireEvent.keyDown(b, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(c, { key: "ArrowRight" }); // envuelve al principio
    expect(onChange).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(a, { key: "ArrowLeft" }); // y hacia atrás
    expect(onChange).toHaveBeenLastCalledWith("c");
  });
});

describe("IconButton", () => {
  it("sin aria-label falla en desarrollo", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // @ts-expect-error aria-label es obligatorio en el tipo; aquí lo omitimos a propósito
    expect(() => render(<IconButton icon={Bell} />)).toThrow(/aria-label/);
    error.mockRestore();
  });

  it("con aria-label es un botón con nombre accesible", () => {
    render(<IconButton icon={Bell} aria-label="Notificaciones" />);
    expect(screen.getByRole("button", { name: "Notificaciones" })).toBeTruthy();
  });
});

describe("TagInput", () => {
  it("Enter y coma añaden, Backspace quita la última y no admite duplicados", () => {
    const onChange = vi.fn();
    function Demo() {
      const [t, setT] = useState<string[]>(["seo"]);
      return (
        <TagInput
          value={t}
          onChange={(x) => {
            setT(x);
            onChange(x);
          }}
        />
      );
    }
    render(<Demo />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "youtube" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(["seo", "youtube"]);
    fireEvent.change(input, { target: { value: "SEO" } });
    fireEvent.keyDown(input, { key: "," });
    expect(onChange).toHaveBeenCalledTimes(1); // duplicado (sin distinguir mayúsculas)
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(onChange).toHaveBeenLastCalledWith(["seo"]);
    fireEvent.click(screen.getByRole("button", { name: "Quitar seo" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

describe("Button y Chip", () => {
  it("loading deshabilita el botón y lo marca como ocupado", () => {
    render(<Button loading>Subir</Button>);
    const b = screen.getByRole("button", { name: /Subir/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
  });

  it("el Chip expone su tono", () => {
    render(<Chip tone="destructive">destructiva</Chip>);
    expect(screen.getByText("destructiva").closest("span")!.getAttribute("data-tone")).toBe("destructive");
  });
});
