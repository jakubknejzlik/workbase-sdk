import adoptDelivery from './001-adopt-delivery'
import senderName from './002-sender-name'

// Applied in this order; never edit or reorder existing migrations, only append.
export const migrations = [
  adoptDelivery,
  senderName,
]
