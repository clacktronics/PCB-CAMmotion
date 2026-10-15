# Machine QA run

- **Date:**
- **Commit:**
- **Machine:** LPKF ProtoMat E44 / Makera Carvera / other:
- **Machine profile + version:**
- **Board:** `samples/test-board/` rev ___ (or other:)
- **Material:** (e.g. FR4 1.6 mm, 35 µm copper)
- **Tools used:** (number, type, diameter / V-angle and tip, feeds and speeds)
- **Operator:**

## 1. Before cutting

- [ ] `npm run check` passes on this commit
- [ ] G-code safety checker passes on the exported files (shown in the app before export)
- [ ] Golden-file diff for this post-processor reviewed

## 2. Air cut (Z raised above the work)

- [ ] Program starts at safe Z, spindle starts before the first cut
- [ ] Every tool change happens at safe Z with the spindle stopped
- [ ] Moves stay inside the expected area; no unexpected rapids
- [ ] Program ends with spindle off and Z up

## 3. Cut the test board

- [ ] Isolation, drilling and outline completed without intervention
- Notes:

## 4. Measurements (mm, compare with `samples/test-board/features.json`)

| Feature | Nominal | Measured | Error | Notes |
|---------|---------|----------|-------|-------|
| Trace 0.10 | 0.10 | | | |
| Trace 0.20 | 0.20 | | | |
| Trace 0.50 | 0.50 | | | |
| Gap 0.10 | 0.10 | | | |
| Gap 0.20 | 0.20 | | | |
| Gap 0.40 | 0.40 | | | |
| Drill 0.4 | 0.40 | | | |
| Drill 1.0 | 1.00 | | | |
| Drill 3.0 | 3.00 | | | |
| Board size X × Y | 80 × 60 | | | |
| Top/bottom registration (alignment holes) | 0 | | | |

Smallest trace that survived: ___ mm. Smallest gap fully isolated: ___ mm.
Smallest readable text: ___ mm.

## 5. Result

- [ ] Pass   - [ ] Fail — follow-up issue / profile correction:

Photos: (paths under `results/`)
