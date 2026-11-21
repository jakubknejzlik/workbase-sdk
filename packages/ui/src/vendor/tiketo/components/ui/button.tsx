import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-100 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:inset-ring disabled:inset-ring-border aria-disabled:cursor-not-allowed aria-disabled:opacity-100 aria-disabled:bg-muted aria-disabled:text-muted-foreground aria-disabled:shadow-none aria-disabled:inset-ring aria-disabled:inset-ring-border [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-xs not-disabled:not-aria-disabled:hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs not-disabled:not-aria-disabled:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs not-disabled:not-aria-disabled:hover:bg-accent not-disabled:not-aria-disabled:hover:text-accent-foreground dark:not-disabled:not-aria-disabled:bg-input/30 dark:not-disabled:not-aria-disabled:border-input dark:not-disabled:not-aria-disabled:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs not-disabled:not-aria-disabled:hover:bg-secondary/80",
        ghost:
          "not-disabled:not-aria-disabled:hover:bg-accent not-disabled:not-aria-disabled:hover:text-accent-foreground dark:not-disabled:not-aria-disabled:hover:bg-accent/50",
        link: "text-foreground underline-offset-4 not-disabled:not-aria-disabled:hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const child = asChild && React.isValidElement<React.ComponentProps<"button">>(props.children)
    ? props.children
    : null
  const slotDisabled = asChild && (
    props.disabled || props["aria-disabled"] === true || props["aria-disabled"] === "true" ||
    child?.props.disabled || child?.props["aria-disabled"] === true || child?.props["aria-disabled"] === "true"
  )
  if (slotDisabled) {
    // Do not mount the child: router Links can regenerate href from `to`.
    // Keep its label/content and presentation, without forwarding interaction
    // handlers, navigation props, roles, tabIndex or refs to the plain text.
    return (
      <span
        data-slot="button"
        aria-disabled="true"
        id={child?.props.id ?? props.id}
        title={child?.props.title ?? props.title}
        aria-label={child?.props["aria-label"] ?? props["aria-label"]}
        aria-labelledby={child?.props["aria-labelledby"] ?? props["aria-labelledby"]}
        aria-describedby={child?.props["aria-describedby"] ?? props["aria-describedby"]}
        className={cn(buttonVariants({ variant, size, className }), child?.props.className)}
        style={{ ...props.style, ...child?.props.style }}
      >
        {child?.props.children}
      </span>
    )
  }

  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

export { Slot }
