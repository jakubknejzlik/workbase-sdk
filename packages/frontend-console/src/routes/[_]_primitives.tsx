import { lazy } from 'react'
import { createFileRoute, notFound } from '@tanstack/react-router'
export const Route = createFileRoute('/__primitives')({
  staticData: { title: 'Primitive proofs' },
  beforeLoad: () => { if (!import.meta.env.DEV && import.meta.env.MODE !== 'primitives-proof') throw notFound() },
  component: import.meta.env.DEV || import.meta.env.MODE === 'primitives-proof' ? lazy(() => import('../primitive-proofs').then(module => ({ default: module.PrimitiveProofs }))) : () => null,
})
