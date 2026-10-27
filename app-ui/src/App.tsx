import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState } from "react";
import { createHashRouter, Navigate, RouterProvider } from "react-router";
import { createClient, type Client } from "./api/client";
import { ClientContext } from "./api/context";
import { useSettings } from "./api/queries";
import { ChatScreen } from "./chat/ChatScreen";

import { CanalScreen } from "./screens/CanalScreen";
import { GuionesScreen } from "./screens/GuionesScreen";
import { KbScreen } from "./screens/KbScreen";
import { OnboardingScreen } from "./screens/OnboardingScreen";
import { PublicarScreen } from "./screens/PublicarScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { AppShell } from "./shell/AppShell";
import { sidecarInfo } from "./sidecar";
import { Estado, Toaster } from "./ui";

// Catálogo de componentes: solo en desarrollo (import dinámico dentro de la rama DEV, que el build elimina).
const Catalogo = import.meta.env.DEV ? lazy(() => import("./screens/CatalogoScreen").then((m) => ({ default: m.CatalogoScreen }))) : null;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// Hash router: en Tauri la página se sirve como fichero, sin servidor que reescriba rutas.
const router = createHashRouter([
  // El asistente de bienvenida va a ancho completo, fuera de la barra lateral.
  { path: "onboarding", element: <OnboardingScreen /> },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Inicio /> },
      { path: "chat", element: <ChatScreen /> },
      { path: "publicar", element: <PublicarScreen /> },
      { path: "guiones", element: <GuionesScreen /> },
      { path: "canal", element: <CanalScreen /> },
      { path: "kb", element: <KbScreen /> },
      { path: "ajustes", element: <SettingsScreen /> },
      ...(Catalogo ? [{ path: "catalogo", element: <Suspense fallback={null}><Catalogo /></Suspense> }] : []),
    ],
  },
]);

/** Abre en Onboarding si falta la clave o el client_secret; si no, en Chat. */
function Inicio() {
  const q = useSettings();
  if (q.isPending) return <Estado>Cargando ajustes…</Estado>;
  if (q.isError) return <Estado error>Error: {q.error.message}</Estado>;
  const listo = q.data.has_anthropic_key && q.data.has_client_secret;
  return <Navigate to={listo ? "/chat" : "/onboarding"} replace />;
}

export default function App() {
  const [client, setClient] = useState<Client | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sidecarInfo()
      .then((info) => setClient(createClient(info.port, info.token)))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <Estado as="main" error data-testid="sidecar-error">
        No se pudo arrancar el sidecar: {error}
      </Estado>
    );
  }
  if (!client) {
    return (
      <Estado as="main" data-testid="sidecar-arrancando">
        Arrancando el sidecar…
      </Estado>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ClientContext.Provider value={client}>
        <RouterProvider router={router} />
        <Toaster />
      </ClientContext.Provider>
    </QueryClientProvider>
  );
}
