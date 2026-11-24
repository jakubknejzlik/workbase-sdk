## Change

Describe the problem and resulting behavior. Reference the related issue.

## Validation

List the checks run and their results.

## SDK UI changes

All SDK UI changes must satisfy the [SDK UI definition of done](../docs/ui/sdk-ui-definition-of-done.md).
For a PR with no UI changes, mark this section “Not applicable” and state why.

- Approved pattern and approved-reference link:
- Recorded owner approval link (new patterns, before implementation; reuse needs no new approval):
- Exact reviewed candidate SHA (full commit hash):
- Independent reviewer identity (authored neither the design nor the implementation):
- Independent visual verdict on that SHA: **PASS / FAIL** (link to review):

Attach whole-page screenshots of the real built console compared with the
approved reference. Provide evidence for each state in both locales and at both
viewport widths:

| State | EN 1440 | EN 390 | CS 1440 | CS 390 |
| --- | --- | --- | --- | --- |
| Empty | | | | |
| Populated | | | | |
| Modified | | | | |
| Saving | | | | |
| Error | | | | |
| Disabled | | | | |
| Permission-reduced | | | | |

- [ ] The implementation brief references the approved pattern.
- [ ] Screenshots and the independent PASS verdict cover the exact candidate SHA.

Functional tests alone are not design acceptance. Missing independent visual
evidence or a FAIL verdict means a UI PR is not done.
