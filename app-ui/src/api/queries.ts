/** Queries compartidas (TanStack Query) sobre el cliente del sidecar. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./context";
import { FASES_ACTIVAS, type SettingsPatch } from "./types";

export function useSettings() {
  const client = useClient();
  return useQuery({ queryKey: ["settings"], queryFn: () => client.getSettings() });
}

export function useYoutubeStatus() {
  const client = useClient();
  return useQuery({ queryKey: ["youtube", "status"], queryFn: () => client.youtubeStatus() });
}

/** Panel de canal: el sidecar cachea 10 min, así que aquí basta con no repetir la petición al volver.
 *  El perfil va en la clave: cada canal tiene su caché y cambiar de perfil nunca muestra los datos
 *  (ni manda al agente los ids de vídeo) del canal anterior (SEO-93). */
export function useCanal(perfil: string | undefined) {
  const client = useClient();
  return useQuery({ queryKey: ["youtube", "canal", perfil], queryFn: () => client.youtubeChannel(), enabled: !!perfil, staleTime: 5 * 60_000 });
}

/** Riesgo y cuota de cada tool, por nombre (casi nunca cambia: se pide una vez por sesión). */
export function useYoutubeTools() {
  const client = useClient();
  return useQuery({
    queryKey: ["youtube", "tools"],
    queryFn: async () => Object.fromEntries((await client.youtubeTools()).map((t) => [t.name, t])),
    staleTime: Infinity,
  });
}

export function usePutSettings() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => client.putSettings(patch),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      void qc.invalidateQueries({ queryKey: ["youtube", "status"] });
    },
  });
}

/** Estado del navegador del render: sondeo cada segundo solo mientras descarga, verifica o instala. */
export function useNavegadorVideo() {
  const client = useClient();
  return useQuery({
    queryKey: ["video", "navegador"],
    queryFn: () => client.videoNavegador(),
    refetchInterval: (q) => (q.state.data && FASES_ACTIVAS.includes(q.state.data.estado) ? 1000 : false),
  });
}

/** Inicia la descarga; con éxito o con 409 (ya en curso) se vuelve a leer el estado real. */
export function useDescargarNavegador() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => client.videoNavegadorDescarga(),
    onSettled: () => qc.invalidateQueries({ queryKey: ["video", "navegador"] }),
  });
}

/** Con el estado vacío el motor hace una prueba de GPU (minutos): solo se pide con el navegador listo. */
export function useCapacidadesVideo(habilitado: boolean) {
  const client = useClient();
  return useQuery({ queryKey: ["video", "capacidades"], queryFn: () => client.videoCapacidades(), enabled: habilitado, staleTime: Infinity, retry: false });
}
