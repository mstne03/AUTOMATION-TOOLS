import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../api/types";
import { costeUsd, reduceTurno, rutaResuelta, turnoVacio, type BloqueTool } from "../chat/turno";
import * as fx from "./fixtures";

const reproducir = (evs: ChatEvent[]) => evs.reduce(reduceTurno, turnoVacio());

describe("reduceTurno", () => {
  it("rechazo: la propuesta queda rechazada y el resultado NO es un error", () => {
    const t = reproducir(fx.publicacionRechazada);
    expect(t.estado).toBe("done");
    expect(t.bloques.map((b) => b.kind)).toEqual(["text", "tool", "text"]);
    expect(t.bloques[0]).toEqual({ kind: "text", text: "Voy a subir el vídeo como privado." });
    const tool = t.bloques[1] as BloqueTool;
    expect(tool.approval?.status).toBe("rejected");
    expect(tool.result).toEqual({ is_error: false, content: fx.REJECTED_TEXT });
    expect(tool.job).toBeUndefined();
    expect(t.usage?.cache_read_input_tokens).toBe(13861);
    expect(t.conversation_id).toBe("conv_1");
  });

  it("aprobación: asocia job y expone la ruta real resuelta, no la del modelo", () => {
    const t = reproducir(fx.publicacionAprobada);
    const tool = t.bloques[0] as BloqueTool;
    expect(tool.approval?.status).toBe("approved");
    expect(tool.job?.status).toBe("done");
    expect(tool.job?.progress).toBe(1);
    expect(tool.input.file_path).toBe("demo cs finance");
    expect(rutaResuelta(tool)).toBe("C:\\Users\\Marc\\Videos\\demo cs finance.mp4");
  });

  it("progreso intermedio del job se refleja al llegar job_finished parcial", () => {
    let t = reproducir(fx.publicacionAprobada.slice(0, 4));
    expect((t.bloques[0] as BloqueTool).job?.progress).toBe(0);
    t = reduceTurno(t, { type: "job_finished", job: { ...fx.jobUpload, status: "running", progress: 0.4 } });
    expect((t.bloques[0] as BloqueTool).job?.progress).toBe(0.4);
    expect(t.estado).toBe("streaming");
  });

  it("destructiva: la propuesta pendiente exige confirm_id", () => {
    const t = reproducir(fx.borradoDestructivo);
    const tool = t.bloques[0] as BloqueTool;
    expect(tool.approval?.risk).toBe("destructive");
    expect(tool.approval?.requires_confirm_id).toBe(true);
    expect(tool.approval?.status).toBe("pending");
    expect(t.estado).toBe("streaming");
  });

  it("dos propuestas de la misma tool se asocian por orden", () => {
    const evs: ChatEvent[] = [
      { type: "tool_use", id: "a", name: "youtube_update_video", input: { video_id: "1" } },
      { type: "tool_use", id: "b", name: "youtube_update_video", input: { video_id: "2" } },
      { type: "approval_required", approval: { ...fx.approvalUpload, id: "p1", tool: "youtube_update_video" } },
      { type: "approval_required", approval: { ...fx.approvalUpload, id: "p2", tool: "youtube_update_video" } },
    ];
    const t = reproducir(evs);
    expect((t.bloques[0] as BloqueTool).approval?.id).toBe("p1");
    expect((t.bloques[1] as BloqueTool).approval?.id).toBe("p2");
  });

  it("error: conserva el texto previo y marca el turno", () => {
    const t = reproducir(fx.errorApi);
    expect(t.estado).toBe("error");
    expect(t.error).toContain("InternalServerError");
    expect(t.bloques[0]).toEqual({ kind: "text", text: "Un momento" });
  });
});

describe("costeUsd", () => {
  it("cuenta la lectura de caché a precio reducido", () => {
    const c = costeUsd("claude-opus-5-5", fx.usage);
    // 420*15 + 180*75 + 13861*1.5 = 6300 + 13500 + 20791.5 = 40591.5 / 1e6
    expect(c).toBeCloseTo(0.0405915, 6);
    expect(costeUsd("claude-sonnet-5-5", fx.usage)).toBeLessThan(c);
    expect(costeUsd("claude-opus-5-5", null)).toBe(0);
  });
});
