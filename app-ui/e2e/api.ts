/** Oráculo: el sidecar real, consultado directamente para contrastar lo que pinta la UI. */
import type { Settings, YouTubeStatus } from "../src/api/types";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(process.env.E2E_SIDECAR + path, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.E2E_TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const settings = () => api<Settings>("/settings");
export const youtube = () => api<YouTubeStatus>("/youtube/status");
