import { workerAccessFixture } from '../../../core/test/fixtures/worker-access'
import { consoleUI } from '@workbasehq/plugins/console'

// Real V3 account-link configuration, with the public invitation UI mounted.
export const workerInvitationConfig = workerAccessFixture()
workerInvitationConfig.interactive = true
workerInvitationConfig.plugins = [...workerInvitationConfig.plugins!, consoleUI()]
