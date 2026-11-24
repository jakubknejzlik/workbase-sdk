# Issue 294 toolbar layout evidence

Candidate: `10d2ec213a8e864216483de24be11e6bbb986da7`
Base: `c31fe5e1914c5daff4cca83427b6caa0aca9d41a` (`integration/preview`).

The built console runs against the existing synthetic List v2 Worker fixture in Chromium 145.0.7632.6, EN, 900 px viewport height. Measurements were taken before implementation and again from a clean checkout of the candidate.

| Width | Base toolbar rows | Candidate rows | Base page scrollWidth/clientWidth | Candidate page scrollWidth/clientWidth |
| --- | --- | --- | --- | --- |
| 1440 | 1 | 2 | 1440/1440 | 1440/1440 |
| 900 | 3 | 2 | 900/900 | 900/900 |
| 390 | 3 | 3 | 390/390 | 390/390 |

Each screenshot filename includes the candidate SHA; `base` images show the pinned base, and `head` images show the candidate. Geometry and build provenance are recorded in the adjacent measurement JSON files.

These captures and DOM assertions provide implementation evidence only. Independent rendered review is pending; no visual PASS verdict is issued here.
