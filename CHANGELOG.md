# Changelog

## Unreleased

### Fixed

- Deep coverage gate exhausts its 60-minute budget on eligible local runners ([pm-swarm-n901](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/issues/pm-swarm-n901.toon))
- Bound coverage reporter memory on Node 26 after a passing source suite ([pm-swarm-9bks](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/issues/pm-swarm-9bks.toon))

### Other

- Adopt pm-cli 2026.11.24 host-aligned SDK behaviour ([pm-swarm-sdk-host-alignment](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/chores/pm-swarm-sdk-host-alignment.toon))

## 2026.11.22 - 2026-11-22

### Dependencies

- Bump unbraind/pm-github/.github/workflows/pm-github-closeout.yml ([#91](https://github.com/unbraind/pm-swarm/pull/91))
- Bump unbraind/pm-ops/.github/workflows/daily-release.yml ([#92](https://github.com/unbraind/pm-swarm/pull/92))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#93](https://github.com/unbraind/pm-swarm/pull/93))

## 2026.11.16 - 2026-11-18

### Other

- Align pinned CLI and managed extension host health versions ([pm-swarm-ci-extension-host-skew](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/tasks/pm-swarm-ci-extension-host-skew.toon))

### Dependencies

- Bump eslint ([#87](https://github.com/unbraind/pm-swarm/pull/87))
- Bump @unbrained/pm-cli ([#86](https://github.com/unbraind/pm-swarm/pull/86))
- Bump the pm-toolchain group across 1 directory with 2 updates ([#83](https://github.com/unbraind/pm-swarm/pull/83))
- Bump @babel/eslint-parser ([#84](https://github.com/unbraind/pm-swarm/pull/84))
- Bump the pm-toolchain group across 1 directory with 2 updates ([#75](https://github.com/unbraind/pm-swarm/pull/75))
- Bump unbraind/pm-github/.github/workflows/pm-github-closeout.yml ([#73](https://github.com/unbraind/pm-swarm/pull/73))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#72](https://github.com/unbraind/pm-swarm/pull/72))
- Bump the codeql-action group with 2 updates ([#71](https://github.com/unbraind/pm-swarm/pull/71))
- Bump @unbrained/pm-cli ([#69](https://github.com/unbraind/pm-swarm/pull/69))
- Bump jscpd ([#70](https://github.com/unbraind/pm-swarm/pull/70))

## 2026.11.11 - 2026-11-11

### Fixed

- PR \#24: valid close after handoff/reclaim fails with swarm_document_changed ([pm-swarm-github-44bd244dd53c-27](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/issues/pm-swarm-github-44bd244dd53c-27.toon))
- Daily release never publishes: npm reads release-artifact/package.tgz as a GitHub repository ([pm-swarm-aa9h](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/issues/pm-swarm-aa9h.toon))

### Other

- Durable multi-item close recovery: slice shipped in \#65 ([pm-swarm-ip1q](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/tasks/pm-swarm-ip1q.toon))
- Durable native close compensation across dependents: slice shipped in \#65 ([pm-swarm-57p6](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/tasks/pm-swarm-57p6.toon))

### Dependencies

- Bump the pm-toolchain group with 3 updates ([#67](https://github.com/unbraind/pm-swarm/pull/67))
- Bump the pm-toolchain group with 2 updates ([#66](https://github.com/unbraind/pm-swarm/pull/66))
- Bump @unbrained/pm-cli ([#64](https://github.com/unbraind/pm-swarm/pull/64))
- Bump unbraind/pm-github/.github/workflows/pm-github-closeout.yml ([#63](https://github.com/unbraind/pm-swarm/pull/63))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#62](https://github.com/unbraind/pm-swarm/pull/62))
- Bump the pm-toolchain group with 3 updates ([#61](https://github.com/unbraind/pm-swarm/pull/61))

## 2026.11.4 - 2026-11-04

### Fixed

- Privacy oracle expectation is stale for pm-cli 2026.10.30 scanMutationSecrets ([pm-swarm-4msd](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/issues/pm-swarm-4msd.toon))

### Other

- Migrate off parent:none SDK sentinel for pm-toolchain 2026.10.30 bump ([pm-swarm-1ii8](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/chores/pm-swarm-1ii8.toon))

### Dependencies

- Bump the pm-toolchain group across 1 directory with 3 updates ([#43](https://github.com/unbraind/pm-swarm/pull/43))

## 2026.11.3 - 2026-11-03

### Dependencies

- Bump the dependencies group with 2 updates ([#54](https://github.com/unbraind/pm-swarm/pull/54))

## 2026.11.2 - 2026-11-02

### Fixed

- The identity gate now recognizes absolute home paths only at path boundaries, so prose and relative paths no longer block the GitHub issue sync ([pm-swarm-4q55](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/issues/pm-swarm-4q55.toon))

## 2026.10.31 - 2026-10-31

### Dependencies

- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#41](https://github.com/unbraind/pm-swarm/pull/41))
- Bump the codeql-action group across 1 directory with 2 updates ([#40](https://github.com/unbraind/pm-swarm/pull/40))
- Bump unbraind/pm-github/.github/workflows/pm-github-closeout.yml ([#42](https://github.com/unbraind/pm-swarm/pull/42))

## 2026.10.29 - 2026-10-29

### Added

- Explain resource deadlocks with fenced request witnesses ([pm-swarm-resource-deadlock-witnesses](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-resource-deadlock-witnesses.toon))
- Integrate settings and package quality gates ([pm-swarm-y972](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-y972.toon))

### Fixed

- Resume fenced close with an SDK workspace transaction ([pm-swarm-atomic-close](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/issues/pm-swarm-atomic-close.toon))

### Dependencies

- Bump the pm-toolchain group with 3 updates ([#37](https://github.com/unbraind/pm-swarm/pull/37))

## 2026.10.28 - 2026-10-28

### Added

- Select ready work fairly using skills, age and handoff costs ([pm-swarm-fair-scheduling](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-fair-scheduling.toon))
- Aggregate revision-bound shared plan progress witnesses ([pm-swarm-plan-progress](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-plan-progress.toon))
- Coordinate parallel agents on a shared tracker without git ([pm-swarm-shared-tracker](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-shared-tracker.toon))
- Reserve explicit shared resources with fenced tracker leases ([pm-swarm-resource-reservations](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-resource-reservations.toon))
- Partition ready work by footprints and dependencies ([pm-swarm-9kio](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-9kio.toon))
- Synchronize linked file footprints ([pm-swarm-cm86](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-cm86.toon))
- Pick and start safe ready work automatically ([pm-swarm-next](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-next.toon))
- Warn or refuse overlapping lane starts ([pm-swarm-overlap](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-overlap.toon))
- Watch live lane status changes ([pm-swarm-watch](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-watch.toon))
- Predict conflicts from real git merges ([pm-swarm-4343](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-4343.toon))
- Retire only merged terminal lanes ([pm-swarm-dbn3](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-dbn3.toon))

### Changed

- Adopt pm-github 2026.10.16: default-branch-safe gated sync and daily gated closeout PRs ([pm-swarm-lux2](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/chores/pm-swarm-lux2.toon))

### Other

- Release readiness behind PM_RELEASE_APPROVED ([pm-swarm-release-gate](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/chores/pm-swarm-release-gate.toon))

### Dependencies

- Bump the pm-toolchain group with 3 updates ([#33](https://github.com/unbraind/pm-swarm/pull/33))
- Bump the pm-toolchain group with 2 updates ([#26](https://github.com/unbraind/pm-swarm/pull/26))
- Bump jscpd ([#22](https://github.com/unbraind/pm-swarm/pull/22))
- Bump the pm-toolchain group across 1 directory with 2 updates ([#20](https://github.com/unbraind/pm-swarm/pull/20))
