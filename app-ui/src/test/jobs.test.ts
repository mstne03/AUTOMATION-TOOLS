import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../api/client";
import type { Job } from "../api/types";
import { esperarJob, reiniciarJobs, seguirJob, useJobs } from "../state/jobs";

const job = (status: Job["status"], progress: number): Job => ({
  id: "j1",
  kind: "transcribe",
  args: {},
  status,
  progress,
  result: null,
  error: null,
  created_at: "2026-10-23T10:00:00Z",
  updated_at: "2026-10-23T10:00:00Z",
});

describe("store de jobs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    reiniciarJobs();
  });

  it("sondea GET /jobs cada segundo mientras haya un job activo y se detiene al acabar", async () => {
    const listJobs = vi.fn().mockResolvedValueOnce([job("running", 0.5)]).mockResolvedValueOnce([job("done", 1)]);
    const client = { listJobs } as unknown as Client;
    seguirJob(client, job("running", 0.1));
    const fin = esperarJob("j1");

    await vi.advanceTimersByTimeAsync(1000);
    expect(useJobs.getState().jobs.j1.progress).toBe(0.5);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await fin).status).toBe("done");

    await vi.advanceTimersByTimeAsync(5000);
    expect(listJobs).toHaveBeenCalledTimes(2); // ya no hay jobs activos: no sigue sondeando
  });

  it("un job que ya está hecho no arranca el sondeo", async () => {
    const listJobs = vi.fn();
    seguirJob({ listJobs } as unknown as Client, job("done", 1));
    expect((await esperarJob("j1")).status).toBe("done");
    await vi.advanceTimersByTimeAsync(3000);
    expect(listJobs).not.toHaveBeenCalled();
  });

  it("un fallo puntual de GET /jobs no corta el sondeo: reintenta y el job termina (SEO-91)", async () => {
    const listJobs = vi.fn().mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce([job("done", 1)]);
    seguirJob({ listJobs } as unknown as Client, job("running", 0.1));
    const fin = esperarJob("j1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await fin).status).toBe("done");
    expect(listJobs).toHaveBeenCalledTimes(2);
  });

  it("con el sidecar caído reintenta cada vez más espaciado, sin dejar de sondear", async () => {
    const listJobs = vi.fn().mockRejectedValue(new Error("Failed to fetch"));
    seguirJob({ listJobs } as unknown as Client, job("running", 0.1));
    await vi.advanceTimersByTimeAsync(60_000);
    // 1 s, 2 s, 4 s, 8 s y luego cada 10 s: ni se rinde ni martillea al sidecar cada segundo.
    expect(listJobs.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(listJobs.mock.calls.length).toBeLessThanOrEqual(9);
  });

  it("si un job activo ya no está en la lista (sidecar reiniciado), se da por fallido y se deja de sondear", async () => {
    const listJobs = vi.fn().mockResolvedValue([]);
    seguirJob({ listJobs } as unknown as Client, job("running", 0.3));
    const fin = esperarJob("j1");
    await vi.advanceTimersByTimeAsync(10_000);
    const j = await fin;
    expect(j.status).toBe("failed");
    expect(j.error).toContain("ya no conoce");
    const llamadas = listJobs.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listJobs).toHaveBeenCalledTimes(llamadas);
  });
});
