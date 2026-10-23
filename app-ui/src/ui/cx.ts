/** Une nombres de clase ignorando los valores vacíos. */
export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");
