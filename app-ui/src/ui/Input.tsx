import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import s from "./controles.module.css";
import { cx } from "./cx";
import { useFieldProps } from "./Field";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return <input ref={ref} {...useFieldProps()} {...rest} className={cx(s.control, mono && s.mono, className)} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 4, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} {...useFieldProps()} {...rest} className={cx(s.control, s.area, className)} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean }>(function Select({ className, compact, ...rest }, ref) {
  return <select ref={ref} {...useFieldProps()} {...rest} className={cx(s.control, compact && s.compacto, className)} />;
});
