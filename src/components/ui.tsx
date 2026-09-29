import type { ButtonHTMLAttributes, ReactNode } from 'react'

export const controlClass =
  'w-full rounded-xl border border-line bg-card px-3 py-2.5 outline-none transition focus:border-pine-ink focus:ring-2 focus:ring-pine-ink/30'

const buttonStyles = {
  primary: 'bg-pine text-on-pine hover:opacity-90',
  quiet: 'border border-line bg-card hover:border-brass',
  danger: 'border border-clay text-clay-ink hover:bg-clay/10',
  ghost: 'hover:bg-brass-soft',
} as const

export function Button({
  variant = 'primary',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonStyles }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${buttonStyles[variant]} ${className}`}
      {...props}
    />
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  )
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="alert" data-testid="form-error" className="rounded-xl bg-clay/10 px-3 py-2 text-sm text-clay-ink">
      {children}
    </p>
  )
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-3xl border border-line bg-card p-5 shadow-[0_18px_50px_rgba(70,48,12,0.05)] ${className}`}>{children}</section>
}
