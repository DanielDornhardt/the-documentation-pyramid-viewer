# Tidewatch architecture

Start with the [storage module](L3-modules/storage.md), the [modules folder](L3-modules/),
the [writing section](L3-modules/storage.md#writing-tides) or the [operations index](L4-operations/index.md).
Also see [outside the docs](../outside.md), the [project page](https://example.org/tides),
[mail the team](mailto:team@example.org), [this overview](#overview) and a [missing page](L3-modules/missing.md).

## Overview

Three small parts: a reader, a store and a page builder.

## Data flow

Readings move from the reader to the store, then to the page builder.

### Ingest

The reader polls a gauge every ten minutes.

### Publish

The page builder writes one static page per day.

## Overview

A second section with the same title, kept on purpose to test duplicate ids.

## The [storage module](L3-modules/storage.md) in short

A heading that contains a link.

## Salt &amp; Spray &copy; notes

A heading with entities.

## The `tide_table` record

A heading with inline code.

## Closing hashes ##

A heading with closing hashes.

## Überblick für Größe

A heading with non-ASCII letters.

## Limits

| Item     | Limit | Unit    |
| -------- | ----- | ------- |
| Readings | 144   | per day |
| Pages    | 1     | per day |
