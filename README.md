# AdminForth ImportExport Plugin

<img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /> <img src="https://woodpecker.devforth.io/api/badges/3848/status.svg" alt="Build Status" /> <a href="https://www.npmjs.com/package/@adminforth/import-export"><img src="https://img.shields.io/npm/dm/@adminforth/import-export" alt="npm downloads" /></a> <a href="https://www.npmjs.com/package/@adminforth/import-export"><img src="https://img.shields.io/npm/v/@adminforth/import-export" alt="npm version" /></a>

[![Ask AI](https://tluma.ai/badge)](https://tluma.ai/ask-ai/devforth/adminforth)

Allows to add import/export to csv options to an adminforth table.

## Features

- Import records into AdminForth tables from CSV or Excel files.
- Export table data to CSV or Excel for external processing and reporting.
- Speed up bulk data operations in the admin panel.
- Support operational workflows around large datasets.

## Documentation

Full setup and configuration guide:

[AdminForth ImportExport Documentation](https://adminforth.dev/docs/tutorial/Plugins/import-export/)

To use the plugin for export only, disable import in the plugin configuration:

```ts
new ImportExport({
  importEnabled: false,
})
```

Import is enabled by default for backward compatibility. Disabling it removes the import action from the UI and does not register the import-related HTTP endpoints.

To import and export Excel workbooks instead of CSV files, set `fileFormat` for the resource:

```ts
new ImportExport({
  fileFormat: 'xlsx',
})
```

CSV remains the default file format. Both formats support `exportViaUpload` for large background exports. XLSX exports that exceed Excel's per-worksheet row limit are split across worksheets, and imports combine worksheets when their columns match.

## About AdminForth

AdminForth is an open-source, agent-first admin framework for building robust admin panels and back-office applications faster.

## Related links

- [AdminForth website](https://adminforth.dev)
- [npm package](https://www.npmjs.com/package/@adminforth/import-export)
- [More AdminForth plugins](https://adminforth.dev/docs/tutorial/ListOfPlugins/)
- [Built by DevForth](https://devforth.io)
