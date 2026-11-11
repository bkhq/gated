# 20261111-1425-audit-record-listing-scans Stop reading every recording file to list command and file records

- **status**: pending
- **priority**: P2
- **owner**: (unassigned)
- **createdAt**: 2026-11-11 14:25

## Description

`gated-admin/src/api/command_records.rs` and `file_records.rs` open and parse every audit recording on disk for each list request, then filter and page in memory. Cost grows with the whole history.

Acceptance:
- Listing a page reads data proportional to the page, with filters applied before loading (index the records in the database or bound the scan by time).
- A test with many recordings shows a bounded number of file reads.

## ActiveForm

Indexing command and file audit records

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Source: full repository audit of `6ecc941` (2026-11-11). Confirmed by reading the code.
