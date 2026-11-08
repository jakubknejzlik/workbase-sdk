import { LayoutDashboard, Users, MapPin, Coins, Wallet, ArrowLeftRight, Settings, Building2, Activity, Workflow, Database, Folder, History } from 'lucide-react'

const icons = { LayoutDashboard, Users, MapPin, Coins, Wallet, ArrowLeftRight, Settings, Building2, Activity, Workflow, Database, Folder, History }
export function NavigationIconView({ name }: { name: string }) {
  const Icon = icons[name as keyof typeof icons] ?? Database
  return <Icon className="text-inherit!" />
}
