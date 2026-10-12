/** Marco común: barra lateral de 220 px + contenido (docs/pantallas.md → Marco común). */
import { NavLink, Outlet } from "react-router";
import { UpdateBanner } from "./UpdateBanner";

const enlaces = [
  ["chat", "Chat"],
  ["publicar", "Publicar vídeo"],
  ["canal", "Panel de canal"],
  ["kb", "Base de conocimiento"],
  ["ajustes", "Ajustes"],
  ["onboarding", "Onboarding"],
] as const;

export function Layout() {
  return (
    <div className="layout">
      <nav data-testid="nav">
        <h2>SEO Studio</h2>
        {enlaces.map(([ruta, nombre]) => (
          <NavLink key={ruta} to={`/${ruta}`} data-testid={`nav-${ruta}`}>
            {nombre}
          </NavLink>
        ))}
      </nav>
      <main>
        <UpdateBanner />
        <Outlet />
      </main>
    </div>
  );
}
