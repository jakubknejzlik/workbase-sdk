import { defineUI } from '@workbasehq/ui-v3'
import schema from '../schema'
import type slots from './-slots'
// Types only: layouts never load the renderer registry or React at runtime.
export const { layout, list, header, row, section, columns, tabs, tab, slot, related, action } = defineUI(schema, 'workers', {} as typeof slots)
