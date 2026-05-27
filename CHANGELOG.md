# Changelog

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
