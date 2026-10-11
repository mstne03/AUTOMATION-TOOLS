/** Queries compartidas (TanStack Query) sobre el cliente del sidecar. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./context";
import type { SettingsPatch } from "./types";

export function useSettings() {
  const client = useClient();
  return useQuery({ queryKey: ["settings"], queryFn: () => client.getSettings() });
}

export function useYoutubeStatus() {
  const client = useClient();
  return useQuery({ queryKey: ["youtube", "status"], queryFn: () => client.youtubeStatus() });
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
