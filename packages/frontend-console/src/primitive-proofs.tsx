// Dev-only proof composition; never linked from the console frame or shipped in production.
import { ActionDialog, RegistryForm, DataTable, DataTableFilterDropdown, TextFilter } from '@workbasehq/ui'
import { useRef, useState } from 'react'
import { Button } from '@workbasehq/ui/components/ui/button'
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogClose } from '@workbasehq/ui/components/ui/dialog'
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel } from '@workbasehq/ui/components/ui/alert-dialog'
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from '@workbasehq/ui/components/ui/sheet'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@workbasehq/ui/components/ui/dropdown-menu'
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@workbasehq/ui/components/ui/tooltip'
import { SidebarProvider, Sidebar, SidebarContent, SidebarMenu, SidebarMenuItem, SidebarMenuButton, useSidebar } from '@workbasehq/ui/components/ui/sidebar'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@workbasehq/ui/components/ui/select'
import { Popover, PopoverTrigger, PopoverContent } from '@workbasehq/ui/components/ui/popover'
import { Calendar } from '@workbasehq/ui/components/ui/calendar'
import { NativeSelect } from '@workbasehq/ui/components/ui/native-select'

function MobileSidebarProof() {
  const { openMobile, setOpenMobile } = useSidebar()
  const trigger = useRef<HTMLButtonElement>(null)
  return <>
    <Button ref={trigger} onClick={() => setOpenMobile(true)}>Open Sidebar mobile sheet</Button>
    <Sidebar mobile onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }} data-proof={openMobile ? 'Sidebar mobile sheet' : undefined}>
      <SidebarContent><nav aria-label="Proof sidebar navigation"><SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild><a href="#proof-navigation">Proof navigation item</a></SidebarMenuButton></SidebarMenuItem></SidebarMenu></nav></SidebarContent>
    </Sidebar>
  </>
}
function DisabledButtonsProof() {
  const [disabled, setDisabled] = useState(true)
  const [activations, setActivations] = useState(0)
  return <fieldset className="space-y-4">
    <legend>Button disabled states</legend>
    <label className="flex items-center gap-2"><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.target.checked)} />Disable example buttons</label>
    <div className="flex flex-wrap gap-2">{(['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const).map(variant => <Button key={variant} variant={variant} disabled={disabled} onClick={() => setActivations(value => value + 1)}>{variant} example</Button>)}</div>
    <output aria-label="Example activations">{activations}</output>
  </fieldset>
}
// Begin custom-slot DataTable proof: local state only, shared desktop/table and mobile/card rendering.
const tableProofStates = ['populated', 'empty', 'error', 'pending', 'pending+error'] as const
type TableProofState = typeof tableProofStates[number]
const tableProofRows = [{ id: 'one', name: 'Sample entry', status: 'Ready' }, { id: 'two', name: 'Another entry', status: 'Draft' }]
function DataTableEmptyContentProof() {
  const [proofState, setProofState] = useState<TableProofState>('populated')
  const pending = proofState === 'pending' || proofState === 'pending+error'
  const failed = proofState === 'error' || proofState === 'pending+error'
  return <section aria-labelledby="custom-slot-proof-title" data-proof="DataTable custom emptyContent" className="relative left-1/2 w-[calc(100vw-2rem)] max-w-6xl -translate-x-1/2 space-y-4 rounded-md border p-4">
    <h2 id="custom-slot-proof-title" className="text-lg font-medium">DataTable custom empty content</h2>
    <p>Static local rows with shared table and mobile card feedback.</p>
    <label htmlFor="custom-slot-proof-state">DataTable proof state</label>
    <NativeSelect id="custom-slot-proof-state" value={proofState} onChange={event => setProofState(event.target.value as TableProofState)}>
      {tableProofStates.map(value => <option key={value} value={value}>{value}</option>)}
    </NativeSelect>
    {pending && <p role="status">Loading proof rows…</p>}
    <DataTable rows={proofState === 'populated' ? tableProofRows : []}
      columns={[{ id: 'name', label: 'Name', cell: row => row.name }, { id: 'status', label: 'Status', cell: row => row.status }]}
      state={{ search: '', sort: null, limit: 10 }} onStateChange={() => {}} page={0} onPage={() => {}}
      isFetching={pending} error={failed ? new Error('The sample rows could not be loaded. Please try again.') : null}
      onRetry={() => setProofState('populated')} onRowClick={() => {}} label="Custom slot sample rows"
      searchAvailable={false} hideFooter mobileCards
      labels={{ search: 'Search sample rows', clearSearch: 'Clear search', noResults: 'No results',
        previous: 'Previous page', next: 'Next page', pageSize: 'Rows per page', range: (start, end) => `${start}–${end}`,
        sort: column => `Sort by ${column}`, error: 'Unable to load sample rows', retry: 'Retry sample rows' }}
      emptyContent={<div className="space-y-3 p-6 text-center">
        <h3 className="text-lg font-medium">No sample entries yet</h3>
        <p className="text-muted-foreground">Add the local sample entries to explore this table.</p>
        <Button type="button" onClick={() => setProofState('populated')}>Add sample entries</Button>
      </div>}
    />
  </section>
}
// End custom-slot DataTable proof.
export function PrimitiveProofs() {
  const [tooltipOpen, setTooltipOpen] = useState(false)
  return <section className="c6a-proofs space-y-4">
    <h1 tabIndex={-1}>Primitive proof harness</h1>
    <p>Development accessibility and CSP proof controls.</p>
    <DataTableEmptyContentProof />
    <DisabledButtonsProof />
    <DataTableFilterDropdown label="Filter proof" active={false} activeLabel="Active filter">{() => <TextFilter value="" onChange={() => {}} label="Contains" />}</DataTableFilterDropdown>
    <Button variant="outline">Outside focus target</Button>
    <Dialog><DialogTrigger asChild><Button>Open Dialog</Button></DialogTrigger><DialogContent data-proof="Dialog"><DialogTitle>Dialog proof</DialogTitle><DialogDescription>Focus is contained without injected styles.</DialogDescription><Button variant="outline">Dialog first action</Button><DialogClose asChild><Button>Close Dialog</Button></DialogClose></DialogContent></Dialog>
    <AlertDialog><AlertDialogTrigger asChild><Button>Open AlertDialog</Button></AlertDialogTrigger><AlertDialogContent data-proof="AlertDialog"><AlertDialogTitle>AlertDialog proof</AlertDialogTitle><AlertDialogDescription>Cancel receives initial focus.</AlertDialogDescription><AlertDialogAction>Confirm proof</AlertDialogAction><AlertDialogCancel>Keep proof</AlertDialogCancel></AlertDialogContent></AlertDialog>
    <Sheet><SheetTrigger asChild><Button>Open Sheet</Button></SheetTrigger><SheetContent data-proof="Sheet"><SheetHeader><SheetTitle>Sheet proof</SheetTitle><SheetDescription>A non-modal sheet with focus containment.</SheetDescription></SheetHeader><Button variant="outline">Sheet first action</Button><SheetClose asChild><Button>Close Sheet</Button></SheetClose></SheetContent></Sheet>
    <DropdownMenu><DropdownMenuTrigger asChild><Button>Open DropdownMenu</Button></DropdownMenuTrigger><DropdownMenuContent data-proof="DropdownMenu"><DropdownMenuItem>First proof item</DropdownMenuItem><DropdownMenuItem>Second proof item</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    <TooltipProvider delayDuration={0}><Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}><TooltipTrigger asChild><Button onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setTooltipOpen(true) } }}>Open Tooltip</Button></TooltipTrigger><TooltipContent data-proof="Tooltip">Noninteractive tooltip proof</TooltipContent></Tooltip></TooltipProvider>
    <div><SidebarProvider className="min-h-0"><MobileSidebarProof /></SidebarProvider></div>
    <label htmlFor="proof-native-select">Native select proof</label><NativeSelect id="proof-native-select" defaultValue="one"><option value="one">One</option><option value="two">Two</option></NativeSelect>
    <ActionDialog trigger="Open portal form" title="Portal form" description="Nested source pickers" cancelLabel="Cancel">{() => <RegistryForm requireDirty schema={{ type: 'object', properties: { choice: { type: 'string' } } }} values={{ choice: 'one' }} label={() => 'Choice'} submitLabel="Save" invalidLabel="Invalid" onSubmit={async () => {}} relation={(_, value, change) => <><label htmlFor="portal-choice">Choice</label><Select value={value} onValueChange={change}><SelectTrigger id="portal-choice"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="one">One</SelectItem><SelectItem value="two">Two</SelectItem></SelectContent></Select><Popover><PopoverTrigger asChild><Button type="button">Calendar picker</Button></PopoverTrigger><PopoverContent aria-label="Calendar picker" className="w-auto p-0"><Calendar mode="single" defaultMonth={new Date('2026-10-01T00:00:00Z')} aria-label="Date picker" /></PopoverContent></Popover></>} />}</ActionDialog>
    <span id="proof-navigation">Navigation target</span>
  </section>
}
