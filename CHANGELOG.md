# Changelog

## 1.6.4 - 2026-06-12

### Fixed
- Fix gallery "select all" selecting every task in the account instead of the visible tasks for the current project, by sharing one filter implementation between the gallery grid and the batch select-all action.

## 1.6.3 - 2026-05-29

### Fixed
- Preserve the selected task space, task status filter, and favorites-only filter across page refreshes.
- Keep the special unassigned task space selected during backend data sync instead of falling back to all tasks.

## 1.6.2 - 2026-05-28

### Added
- Add a controlled backend remote-image cache for template, example, and Open Prompt images with SSRF protections, MIME and size validation, cache headers, and bounded local retention.
- Add image load fallback UI with retry controls for remote template and Open Prompt preview images.
- Add a dist smoke check to guard against accidental Service Worker registration regressions.

### Changed
- Remove active Service Worker registration and clean legacy browser CacheStorage entries on startup.
- Use uv-managed backend test execution and add async pytest support for generation runtime tests.
- Extend release version checks to cover the NAS single-image env example.

### Fixed
- Fix deployed `/sw.js` MIME fallback errors by no longer requesting a missing Service Worker file.
- Fix Open Prompt cached image URLs so they are signed and bound to the preview-time image URL instead of drifting when upstream content changes.
- Fix reviewer template-review permissions in the frontend to match backend reviewer/admin rules.
- Fix public/discover template pagination so server pages beyond the initial local window can load.
- Fix backup restore admin preservation and harden backup import archive limits.
- Fix queued generation rate limiting for `/api/generations/run` before task persistence.
- Prevent direct asset uploads or forged generated asset rows from creating public template samples without valid completed task output linkage.
- Ensure private/review-only remote template images use private cache headers while approved public templates remain immutable public cacheable.

## 1.6.1 - 2026-05-27

### Added
- Add category and tag filters to the Open Prompt import preview.
- Add task retry, batch cancellation, and batch project-move workflow refinements.

### Changed
- Improve Open Prompt import quality scoring so realistic prompts can reach the 70+ quality filter.
- Make edit-output and reuse-config composer behavior refresh Remix lineage and replace references predictably.
- Clarify the operation guide with the independently maintained repository and upstream reference.
- Show generated task creation time on image cards instead of duplicate size metadata.

### Fixed
- Preserve existing API keys when editing channels with a blank API Key field.
- Preserve Remix lineage when queueing with the `keep_all` composer clear mode.
- Treat VPS/browser clipboard fallback success as a successful copy instead of an error.
- Reject code/documentation-like Open Prompt sections during import preview.
- Reduce safe dynamic-SQL and dead-code scanner noise.

## 1.6.0 - 2026-05-27

### Added
- Add failed-generation retry actions in task cards and task details.
- Add batch cancellation for selected queued/running tasks.
- Add batch move-to-project actions for selected tasks.
- Add a release version consistency check for `package.json`, `package-lock.json`, and `v*` Git tags.
- Create GitHub Releases from tag-based Docker publishes so the in-app update check has a canonical release source.

### Fixed
- Fix batch generation deletion leaving shared assets orphaned.
- Persist task favorite changes to the backend.
- Stop task deletion actions from claiming success when backend deletion fails.
- Preserve loaded task/template pagination during background sync.
- Reset task-card thumbnail state when outputs change.
- Replace weak SHA1 hashing for open-prompt item keys with SHA256.

### Documentation
- Document `package.json` as the canonical application version source and clarify the release flow.
- Refresh single-image deployment version examples to avoid stale hardcoded versions.
