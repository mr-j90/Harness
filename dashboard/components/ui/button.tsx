import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const buttonVariants = cva("inline-flex items-center justify-center", {
  variants: { variant: { ghost: "bg-transparent", default: "bg-foreground text-background" } },
  defaultVariants: { variant: "default" },
});

type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };
function Button({ className, variant, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return <Component className={twMerge(clsx(buttonVariants({ variant }), className))} {...props} />;
}
export { Button, buttonVariants };
