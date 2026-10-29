import { describe, expect, it } from "vitest";
import { nombreAlmacen } from "../screens/SettingsScreen";

describe("Ajustes", () => {
  it("nombre legible del almacén de secretos", () => {
    expect(nombreAlmacen("KeyringSecretStore")).toBe("Administrador de credenciales de Windows");
    expect(nombreAlmacen("FileSecretStore")).toBe("Fichero local (modo de pruebas)");
    expect(nombreAlmacen("Otro")).toBe("Otro");
  });
});
