/** Marco común (docs/pantallas.md → Marco común): barra lateral de 248 px + contenido. */
import { Outlet, useLocation } from "react-router";
import { CommandPalette } from "../CommandPalette";
import { UpdateBanner } from "../UpdateBanner";
import s from "./AppShell.module.css";
import { Sidebar } from "./Sidebar";

/** Pantallas ya rediseñadas que gestionan su propio padding (a sangre); el resto conserva el margen heredado. */
const A_SANGRE = ["/chat", "/publicar", "/canal", "/ajustes", "/kb"];

export function AppShell() {
  const { pathname } = useLocation();
  const sangre = A_SANGRE.some((r) => pathname === r || pathname.startsWith(r + "/"));
  return (
    <div className={s.shell}>
      <Sidebar />
      <main className={sangre ? s.principalSangre : s.principal}>
        <UpdateBanner />
        <Outlet />
      </main>
      <CommandPalette />
    </div>
  );
}
