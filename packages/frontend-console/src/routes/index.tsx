import { createFileRoute } from '@tanstack/react-router'
import { LayoutDashboard } from 'lucide-react'
import { Overview } from '../frame'
export const Route = createFileRoute('/')({ staticData: { title: 'overview', crumb: 'overview', icon: <LayoutDashboard /> }, component: Overview })
