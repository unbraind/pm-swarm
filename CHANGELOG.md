# Changelog

## 2026.10.15 - 2026-10-15

### Added

- Coordinate parallel agents on a shared tracker without git ([pm-swarm-shared-tracker](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-shared-tracker.toon))
- Reserve explicit shared resources with fenced tracker leases ([pm-swarm-resource-reservations](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-resource-reservations.toon))
- Aggregate revision-bound shared plan progress witnesses ([pm-swarm-plan-progress](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-plan-progress.toon))
- Select ready work fairly using skills, age and handoff costs ([pm-swarm-fair-scheduling](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-fair-scheduling.toon))
- Partition ready work by footprints and dependencies ([pm-swarm-9kio](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-9kio.toon))
- Synchronize linked file footprints ([pm-swarm-cm86](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-cm86.toon))
- Pick and start safe ready work automatically ([pm-swarm-next](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-next.toon))
- Warn or refuse overlapping lane starts ([pm-swarm-overlap](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-overlap.toon))
- Watch live lane status changes ([pm-swarm-watch](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-watch.toon))
- Predict conflicts from real git merges ([pm-swarm-4343](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-4343.toon))
- Retire only merged terminal lanes ([pm-swarm-dbn3](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/features/pm-swarm-dbn3.toon))

### Changed

- Adopt pm-github 2026.10.16: default-branch-safe gated sync and daily gated closeout PRs ([pm-swarm-lux2](https://github.com/unbraind/pm-swarm/blob/main/.agents/pm/chores/pm-swarm-lux2.toon))
