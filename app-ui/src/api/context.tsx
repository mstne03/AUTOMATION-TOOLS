import { createContext, useContext } from "react";
import type { Client } from "./client";

export const ClientContext = createContext<Client | null>(null);

export function useClient(): Client {
  const c = useContext(ClientContext);
  if (!c) throw new Error("useClient fuera de <ClientContext.Provider>");
  return c;
}
