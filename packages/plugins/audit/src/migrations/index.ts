import adoptOutbox from './001-adopt-outbox'
import deliveryBackoff from './002-delivery-backoff'

// Applied in this order; never edit or reorder existing migrations, only append.
export const migrations = [
  adoptOutbox,
  deliveryBackoff,
]
