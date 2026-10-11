import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { createHashRouter, Navigate, RouterProvider } from "react-router";
import { createClient, type Client } from "./api/client";
import { ClientContext, useClient } from "./api/context";
import { ChatScreen } from "./chat/ChatScreen";
import { Layout } from "./Layout";
import { sidecarInfo } from "./sidecar";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const Pendiente = ({ nombre }: { nombre: string }) => <h1>{nombre} (pendiente)</h1>;

// Hash router: en Tauri la página se sirve como fichero, sin servidor que reescriba rutas.
const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Inicio /> },
      { path: "chat", element: <ChatScreen /> },
      { path: "publicar", element: <Pendiente nombre="Publicar vídeo" /> },
      { path: "canal", element: <Pendiente nombre="Panel de canal" /> },
      { path: "kb", element: <Pendiente nombre="Base de conocimiento" /> },
      { path: "ajustes", element: <Pendiente nombre="Ajustes" /> },
      { path: "onboarding", element: <Pendiente nombre="Onboarding" /> },
    ],
  },
]);

/** Abre en Onboarding si falta la clave o el client_secret; si no, en Chat. */
function Inicio() {
  const client = useClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => client.getSettings() });
  if (q.isPending) return <p className="estado">Cargando ajustes…</p>;
  if (q.isError) return <p className="estado">Error: {q.error.message}</p>;
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
      <main className="estado" data-testid="sidecar-error">
        No se pudo arrancar el sidecar: {error}
      </main>
    );
  }
  if (!client) {
    return (
      <main className="estado" data-testid="sidecar-arrancando">
        Arrancando el sidecar…
      </main>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ClientContext.Provider value={client}>
        <RouterProvider router={router} />
      </ClientContext.Provider>
    </QueryClientProvider>
  );
}
