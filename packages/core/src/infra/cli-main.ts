import { runCli, migrationErrorMessage } from './cli'

// Executable entry only. Keeping this out of the /infra import graph prevents
// import.meta.url === argv[1] from accidentally running the CLI in an SST bundle.
const env = { ...process.env }
runCli(process.argv.slice(2), env).catch(error => {
  console.error(migrationErrorMessage(error, env)); process.exitCode = 1
})
