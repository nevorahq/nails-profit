# Material create returned `The request body is invalid`

- Symptom: selecting a fixed starter suggestion in `/app/materials` and submitting “Добавить материал” returned HTTP 422 with `The request body is invalid`.
- Root cause: the controlled base-unit select was disabled for every selected suggestion. Disabled form controls are omitted from `FormData`, so a starter material that did not yet exist in the database was posted with `base_unit: null`, which failed the API `z.enum(materialUnits)` schema.
- Fix: request construction now reads the controlled `addUnit` state for all newly created materials. Existing materials still use the append-only price endpoint and omit catalogue fields.
- Regression: `components/material-catalogue.test.ts` covers both a fixed starter creation payload and an existing starter price payload.
- Verification: typecheck, ESLint, targeted tests (7/7), and the full unit suite (688/688) pass.
- Status: DONE.
