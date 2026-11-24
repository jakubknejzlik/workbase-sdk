# SDK UI definition of done

Mandatory for all SDK UI changes, as required by [#222](https://github.com/jakubknejzlik/workbase-sdk/issues/222).
The approved [List v2 pattern](patterns/list-v2.md) is an existing reference.

## A — Before implementing a new pattern

For any UI pattern that is not already approved:

1. Provide a short interaction flow describing states and transitions.
2. Provide a reference of the **whole page** containing the pattern, rather than
   the component in isolation. Cover this state × locale × viewport matrix:

   | States | Locales | Viewport widths |
   | --- | --- | --- |
   | Empty, populated, modified, saving, error, disabled, permission-reduced | EN and CS | Desktop 1440 px and mobile 390 px |

3. Obtain **owner approval of the pattern before implementation**. Record the
   approval and the approved reference link in the pattern record so subsequent
   briefs and reviews can identify the approved design.

The later draft comments in #222 proposing to replace routine owner approval do
not supersede this requirement.

## B — Every UI PR

An independent visual reviewer who authored neither the design nor the
implementation must review the **real rendered page from the built console**
against the approved reference, across the same state × locale × viewport matrix
in section A.

Attach the screenshots, approved-reference link, **exact candidate commit SHA**,
reviewer identity and **PASS/FAIL** verdict to the PR. The verdict must identify
the reviewed SHA; after a candidate changes, obtain review evidence for the new
candidate. A FAIL or missing independent visual evidence means the PR is not done.

**Functional tests alone are never design acceptance.** Unit tests, browser
assertions and a screenshot capture job do not replace independent visual review
of the built whole page against the approved reference.

## C — Reuse

Reusing an already-approved pattern requires **no new owner approval**.
Section B still applies to every UI PR touching that pattern.

## D — Briefs

Implementation briefs must reference an approved pattern and must not invent UI
shape. If no approved pattern applies, **stop implementation and complete A**
before proceeding.
