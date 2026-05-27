# Changelog

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
