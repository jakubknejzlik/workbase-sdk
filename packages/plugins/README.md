# @workbasehq/plugins

Reusable SDK plugins are available through explicit package subpaths.

The Console UI data contract is `@workbasehq/plugins/console/ui`. Build-time
validation and Vite integration use `/console/ui/check` and `/console/ui/vite`.
See the [UI contract and adapter guide](console/ui/README.md) for authoring,
optional build peers and generated-route setup.

Allowed `ui/**/*.ts` top-level code runs at the same trust as `vite.config.ts`.
This is not a sandbox. Extraction first loads config through the SDK's static
loader and validates the UI import graph, then evaluates UI data with browser
components stubbed only in the extraction server. The app build uses the real
components. Unresolved or unclassified imports are rejected.
