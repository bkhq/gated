import type { VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '@/shared/lib/utils'

const buttonVariants = cva(
  'focus-ring inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent font-medium transition duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-50 disabled:active:translate-y-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:brightness-90',
        secondary: 'border-border bg-secondary text-secondary-foreground hover:bg-accent',
        outline: 'border-border bg-transparent text-foreground hover:bg-accent',
        ghost: 'bg-transparent text-foreground hover:bg-accent',
        destructive: 'bg-destructive text-destructive-foreground hover:brightness-90',
        link: 'h-auto bg-transparent p-0 text-foreground underline underline-offset-4',
      },
      size: {
        'sm': 'h-[30px] px-2.5 text-[13px]',
        'md': 'h-9 px-3.5 text-sm',
        'lg': 'h-[42px] px-[18px] text-sm',
        'icon': 'h-8 w-8 p-0 text-sm',
        'icon-sm': 'h-7 w-7 p-0 text-[13px]',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'md',
    },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  ref?: React.Ref<HTMLButtonElement>
}

export function Button({ className, variant, size, ref, ...props }: ButtonProps) {
  return <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
