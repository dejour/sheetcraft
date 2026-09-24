import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap rounded-[7px] border px-3.5 text-sm font-medium transition-[background,border-color,transform,opacity] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--violet)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-[var(--teal-dark)] bg-[var(--teal)] text-white hover:-translate-y-px",
        secondary: "border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:-translate-y-px hover:border-[var(--teal)]",
        ghost: "border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:-translate-y-px hover:border-[var(--teal)]"
      },
      size: {
        default: "min-h-10 px-3.5",
        sm: "min-h-9 px-3",
        lg: "min-h-11 px-4"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
});
Button.displayName = "Button";

export { Button, buttonVariants };
