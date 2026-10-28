# Vendored fonts

IBM Plex Sans and IBM Plex Mono, used by the metal skin. The files are the official, unmodified `complete/woff2` files of the published npm packages. They are not subset, converted or renamed (the font name "Plex" is a Reserved Font Name under the licence). The viewer embeds them in the HTML export (base64 in `skins/metal-fonts.css`) and serves them in serve mode from `/assets/fonts/`.

Licence: SIL Open Font License 1.1, Copyright (c) 2017 IBM Corp. with Reserved Font Name "Plex". The full text is in `OFL.txt` next to the fonts and is the licence file of both packages (the two copies are identical).

## Sources

| Package | Version | Tarball integrity (npm, sha512) |
| ------- | ------- | ------------------------------- |
| `@ibm/plex-sans` | 1.1.0 | `sha512-WPgvO6Yfj2w5YbhyAr1tv95RUz4LRJlqN+CmYvBglabXteufP1D1E9BABMde+ZIKdRbFJDoKF5eQzfhpnbgZcQ==` |
| `@ibm/plex-mono` | 2.5.0 | `sha512-STBJIPxPomOYPmBMO7z5TKPJUotAF9u3gAUumTqVgwgrAO+K4FRNh0MlhsoJjKhJKsMbBJR10/bk4inkj/wc1w==` |

The tarballs were downloaded from https://registry.npmjs.org on 2026-10-28, their integrity values were checked against the registry metadata, and the files below were copied out of `fonts/complete/woff2/`.

## Files

| File | Bytes | sha256 |
| ---- | ----- | ------ |
| `IBMPlexMono-Regular.woff2` | 49248 | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` |
| `IBMPlexSans-Bold.woff2` | 63012 | `fa7130d854a660b39a7fc9e6e0f2dc23dba5f1346e2adea3e1fe37b6d884133d` |
| `IBMPlexSans-Italic.woff2` | 67220 | `13284fab1821ba6e3652c1580fcf2bbfd8c9309520c69b3d1224dab40b37c597` |
| `IBMPlexSans-Medium.woff2` | 66740 | `5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d` |
| `IBMPlexSans-Regular.woff2` | 63020 | `ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a` |
| `IBMPlexSans-SemiBold.woff2` | 67060 | `f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205` |

The test `tests/fonts.test.js` computes the sha256 of every file in this folder and fails unless the hash appears in this notice, so a changed file needs a new row.

Only the weights and styles that the metal skin uses are included: Sans regular, medium, semibold, bold and italic, and Mono regular. A change of the skin's weights needs the matching file from the same packages.

Unverified: the viewer did not check the font files against IBM's GitHub release, only against the npm registry integrity of the package that contains them.
