# SDK 0.2.1 upgrade fixture

Copied from test-project commit `e0df612`, revision 3 (`config.v3.ts`),
W41 on 2026-11-04. Includes its committed schema-only SQL through the 0.2.1
metadata upgrade and revision-3 history/indexes. No client records, credentials,
consumer environment files or client names are included. The standalone config
uses the archived version without console history wiring; the history data is
unchanged. Seven entities lack displayField. Tests also exercise a legacy ref
used as displayField without changing this historical fixture.

Keep these files immutable across SDK releases. The upgrade gate must load them
without pre-upgrading SQL or silently fixing configuration data.
