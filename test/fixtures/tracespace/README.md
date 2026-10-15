# tracespace spec-feature fixtures

Small Gerber/Excellon files, one feature each, from the
[tracespace](https://github.com/tracespace/tracespace) project (`@tracespace/fixtures` 4.2.7,
MIT licence, see `LICENSE`). tracespace's own SVG renders are not included.

`gerber-filenames.json` lists file names from many CAD tools with the expected layer
type and side; it drives the layer-identification test.

`regions/region-with-lines.gbr` is genuinely invalid (its region contour is not closed) and
is expected to give exactly that error.
