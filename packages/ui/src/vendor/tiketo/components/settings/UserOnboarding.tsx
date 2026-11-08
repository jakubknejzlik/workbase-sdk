import type { ReactNode } from 'react'
import { Card, CardDescription, CardFooter, CardHeader } from '../ui/card'

/** Source UserOnboarding Card with semantic heading and host form slot. */
export function UserOnboarding({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="min-h-screen flex items-center justify-center p-4">
    <div className="max-w-md w-full space-y-8"><Card className="relative">
      <CardHeader className="text-center">
        <h1 tabIndex={-1} className="text-3xl font-bold mb-2">{title}</h1>
        <CardDescription className="mb-4">{description}</CardDescription>
      </CardHeader>
      <CardFooter>{children}</CardFooter>
    </Card></div>
  </div>
}
