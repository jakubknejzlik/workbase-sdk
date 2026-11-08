import { z } from 'zod'
import { defineAtomicOperation } from '../../../src/execution/atomic'
import { createCommandRegistry } from '../../../src/commands'
import { ApiError } from '../../../src/errors'
import type { PreparationContext } from '../../../src/execution/types'

// Deliberately small counter operations for SDK replay/concurrency tests. No instance code.
const reference = (entity: string) => z.string().meta({ referenceEntity: entity })
const read = async (ctx: PreparationContext, table: string, id: string) => {
  const row = await ctx.reader.first<Record<string, any>>({ sql: `SELECT * FROM ${table} WHERE organization_id=? AND id=?`, bindings: [ctx.scope.organizationId, id] })
  if (!row) throw new ApiError(404, 'not_found')
  return row
}
const create = defineAtomicOperation({
  name: 'bookings/create', permission: { entity: 'bookings', operation: 'create' }, idempotency: 'required',
  input: z.strictObject({ slotId: reference('slots'), clientId: reference('clients') }),
  prepare: async (ctx, input) => { await read(ctx, 'slots', input.slotId); await read(ctx, 'clients', input.clientId) },
  plan(ctx, input) {
    const row = { id: ctx.newId, organization_id: ctx.scope.organizationId, slot_id: input.slotId, client_id: input.clientId, status: 'confirmed', client_snapshot_name: '', created_at: ctx.now, updated_at: ctx.now, version: 1 }
    return {
      rules: [{ name: 'counter', statements: [
        { sql: 'UPDATE slots SET booked=booked+1 WHERE organization_id=? AND id=? AND booked<capacity', bindings: [ctx.scope.organizationId, input.slotId], expectRows: 1, diagnose: { sql: 'SELECT EXISTS(SELECT 1 FROM slots WHERE organization_id=? AND id=? AND booked<capacity) AS ok', bindings: [ctx.scope.organizationId, input.slotId] } },
        { sql: 'INSERT INTO bookings (id,organization_id,slot_id,client_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', bindings: [row.id, row.organization_id, row.slot_id, row.client_id, row.status, ctx.now, ctx.now], expectRows: 1 },
      ] }],
      conflict: 'capacity_exceeded', result: { status: 201, body: row }, event: { entity: 'bookings', entityId: row.id, operation: 'booking.created' },
    }
  },
})
const cancel = defineAtomicOperation({
  name: 'bookings/cancel', permission: { entity: 'bookings', operation: 'update' },
  input: z.strictObject({ bookingId: reference('bookings') }), prepare: (ctx, input) => read(ctx, 'bookings', input.bookingId),
  plan(ctx, input) {
    const before = ctx.prepared
    return {
      rules: [{ name: 'counter', statements: [
        { sql: "UPDATE bookings SET status='cancelled',version=version+1 WHERE organization_id=? AND id=? AND status='confirmed'", bindings: [ctx.scope.organizationId, input.bookingId], expectRows: 1, diagnose: { sql: "SELECT EXISTS(SELECT 1 FROM bookings WHERE organization_id=? AND id=? AND status='confirmed') AS ok", bindings: [ctx.scope.organizationId, input.bookingId] } },
        { sql: 'UPDATE slots SET booked=booked-1 WHERE organization_id=? AND id=?', bindings: [ctx.scope.organizationId, before.slot_id], expectRows: 1 },
      ] }],
      conflict: 'already_cancelled', result: { status: 200, body: { ...before, status: 'cancelled', version: before.version + 1 } }, event: { entity: 'bookings', entityId: input.bookingId, operation: 'booking.cancelled' },
    }
  },
})
const move = defineAtomicOperation({
  name: 'bookings/move', permission: { entity: 'bookings', operation: 'update' },
  input: z.strictObject({ bookingId: reference('bookings'), toSlotId: reference('slots') }),
  prepare: async (ctx, input) => { await read(ctx, 'slots', input.toSlotId); return read(ctx, 'bookings', input.bookingId) },
  plan(ctx, input) {
    const before = ctx.prepared
    return {
      rules: [{ name: 'counter', statements: [
        { sql: 'UPDATE slots SET booked=booked+1 WHERE organization_id=? AND id=? AND booked<capacity', bindings: [ctx.scope.organizationId, input.toSlotId], expectRows: 1, diagnose: { sql: 'SELECT EXISTS(SELECT 1 FROM slots WHERE organization_id=? AND id=? AND booked<capacity) AS ok', bindings: [ctx.scope.organizationId, input.toSlotId] } },
        { sql: 'UPDATE slots SET booked=booked-1 WHERE organization_id=? AND id=?', bindings: [ctx.scope.organizationId, before.slot_id], expectRows: 1 },
        { sql: "UPDATE bookings SET slot_id=?,version=version+1 WHERE organization_id=? AND id=? AND status='confirmed'", bindings: [input.toSlotId, ctx.scope.organizationId, input.bookingId], expectRows: 1 },
      ] }],
      conflict: 'capacity_exceeded', result: { status: 200, body: { ...before, slot_id: input.toSlotId, version: before.version + 1 } }, event: { entity: 'bookings', entityId: input.bookingId, operation: 'booking.moved' },
    }
  },
})
export const counterCommands = createCommandRegistry([create, cancel, move])
