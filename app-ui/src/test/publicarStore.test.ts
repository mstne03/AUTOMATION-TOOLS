/** Store de Publicar (SEO-90): una transcripción descartada no escribe su resultado. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../api/client";
import type { Job } from "../api/types";
import { reiniciarConversaciones } from "../state/conversations";
import { reiniciarJobs, seguirJob } from "../state/jobs";
import { descartar, reiniciarPublicar, setPath, transcribir, usePublicar } from "../state/publicar";

const job = (id: string, status: Job["status"], texto?: string): Job => ({
  id,
  kind: "transcribe",
  args: {},
  status,
  progress: status === "done" ? 1 : 0.2,
  result: texto ? { full_text: texto } : null,
  error: null,
  created_at: "2026-10-25T10:00:00Z",
  updated_at: "2026-10-25T10:00:00Z",
});

describe("transcribir y Descartar", () => {
  afterEach(() => {
    reiniciarPublicar();
    reiniciarConversaciones();
    reiniciarJobs();
  });

  it("la transcripción descartada no pisa a la nueva ni el estado vacío (SEO-90)", async () => {
    let n = 0;
    // listJobs no termina nunca: los jobs acaban cuando el test los marca como hechos.
    const client = { createJob: vi.fn(async () => job(`j${++n}`, "running")), listJobs: vi.fn(() => new Promise(() => {})) } as unknown as Client;

    setPath("C:\Videos\a.mp4");
    const primera = transcribir(client);
    await vi.waitFor(() => expect(usePublicar.getState().jobId).toBe("j1"));
    descartar();
    expect(usePublicar.getState()).toMatchObject({ jobId: null, transcribiendo: false, path: "" });

    setPath("C:\Videos\b.mp4");
    const segunda = transcribir(client);
    await vi.waitFor(() => expect(usePublicar.getState().jobId).toBe("j2"));

    seguirJob(client, job("j1", "done", "texto del vídeo A")); // termina la descartada
    await primera;
    expect(usePublicar.getState()).toMatchObject({ transcripcion: null, transcribiendo: true, errorTranscripcion: null });

    seguirJob(client, job("j2", "done", "texto del vídeo B"));
    await segunda;
    expect(usePublicar.getState()).toMatchObject({ transcripcion: "texto del vídeo B", transcribiendo: false });
  });

  it("un fallo de la transcripción descartada tampoco se muestra", async () => {
    const client = { createJob: vi.fn(async () => job("j1", "running")), listJobs: vi.fn(() => new Promise(() => {})) } as unknown as Client;
    setPath("C:\Videos\a.mp4");
    const t = transcribir(client);
    await vi.waitFor(() => expect(usePublicar.getState().jobId).toBe("j1"));
    descartar();
    seguirJob(client, { ...job("j1", "failed"), error: "Whisper ha fallado" });
    await t;
    expect(usePublicar.getState()).toMatchObject({ errorTranscripcion: null, transcribiendo: false, transcripcion: null });
  });
});
