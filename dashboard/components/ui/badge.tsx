import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
const badgeVariants = cva("inline-flex items-center", { variants: { variant: { default: "", secondary: "" } }, defaultVariants: { variant: "default" } });
function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) { return <span className={twMerge(clsx(badgeVariants({ variant }), className))} {...props}/>; }
export { Badge };
