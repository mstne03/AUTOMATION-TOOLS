import { LoaderCircle } from "lucide-react";
import s from "./Spinner.module.css";

export function Spinner({ label = "Cargando" }: { label?: string }) {
  return (
    <span role="status" aria-label={label} className={s.spinner}>
      <LoaderCircle aria-hidden size="1em" />
    </span>
  );
}
